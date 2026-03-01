#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

/*
作用:
1) 提供一个可供 Clash 导入/更新的订阅链接 B（默认路径 /sub）。
2) 每次请求 B 时，实时拉取订阅 A。
3) 在返回的 YAML 中新增链式代理节点（dialer-proxy）。
4) 保持原有配置，仅做增量插入后返回给 Clash。

使用方法:
1) 先填写下面“用户手动填写”区域。
2) 启动服务:
   - 前台运行: node subscription_bridge_server.js start
   - 后台运行: nohup node subscription_bridge_server.js start > bridge.log 2>&1 &
   - 前台和后台都会输出日志，且同时写入 LOG_FILE 指定文件
   - 当 PUBLIC_BASE_URL 为空时，会自动探测公网 IP 并用于订阅链接 B
3) 在 Clash 中导入脚本启动日志里输出的“订阅链接 B”。
4) 查看状态: node subscription_bridge_server.js status
5) 停止服务: node subscription_bridge_server.js stop

停止进程:
1) 启动该进程的同一终端: Ctrl + C
2) 任意终端: node subscription_bridge_server.js stop
*/

// ===== 用户手动填写 =====
// 订阅 A 链接（必须是 http/https）
const SUBSCRIPTION_URL_A = "";
// 新增代理节点信息，格式: IP:PORT:USER:PASSWORD
const NEW_PROXY_INFO = "";
// 新增节点名称
const NEW_NODE_NAME = "PrivateProxy";
// 监听地址和端口（B 订阅对外地址）
const HOST = "0.0.0.0";
const PORT = 8090;
// B 订阅路径，例如 /sub
const B_PATH = "/sub";
// 可选：对外访问 B 的基础地址（建议远程服务器填写域名，如 https://sub.example.com）
// 留空时会自动探测远程主机公网 IP 来生成订阅链接
const PUBLIC_BASE_URL = "";
// 可选：B 订阅访问令牌（留空表示不鉴权）
const B_TOKEN = "";
// 可选：拉取 A 的超时时间（毫秒）
const FETCH_TIMEOUT_MS = 20000;
// 可选：探测公网 IP 的请求超时时间（毫秒）
const PUBLIC_IP_DETECT_TIMEOUT_MS = 3500;
// 可选：上游订阅 A 需要 Authorization 时填写，例如 "Bearer xxx"
const UPSTREAM_AUTH_HEADER = "";
// 服务 PID 文件路径（用于 stop/status）
const PID_FILE = path.resolve(__dirname, "subscription_bridge_server.pid");
// 服务日志文件路径（所有日志统一写入此文件）
const LOG_FILE = path.resolve(__dirname, "subscription_bridge_server.log");
// ======================

function fail(message) {
  throw new Error(message);
}

function log(level, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch (error) {
    // 日志写文件失败时不影响主流程，只输出到控制台
    console.error(`[${ts}] [WARN] 写入日志文件失败: ${error.message || String(error)}`);
  }
}

function logInfo(message) {
  log("INFO", message);
}

function logWarn(message) {
  log("WARN", message);
}

function logError(message) {
  log("ERROR", message);
}

function stripWrappedQuotes(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseProxyInfo(raw) {
  const parts = raw.split(":");
  if (parts.length !== 4) {
    fail("NEW_PROXY_INFO 格式错误，应为 IP:PORT:USER:PASSWORD");
  }
  const [ip, port, username, password] = parts;
  if (!/^\d+$/.test(port)) {
    fail("NEW_PROXY_INFO 中 PORT 必须是数字");
  }
  return { ip, port, username, password };
}

function detectDialerGroup(lines) {
  let inGroups = false;
  let currentName = "";
  let byName = "";
  let byType = "";

  for (const line of lines) {
    if (/^proxy-groups:\s*$/.test(line)) {
      inGroups = true;
      continue;
    }
    if (inGroups && /^[^\s]/.test(line)) {
      inGroups = false;
    }
    if (!inGroups) {
      continue;
    }

    if (/^  - name:\s*/.test(line)) {
      currentName = stripWrappedQuotes(line.replace(/^  - name:\s*/, ""));
      if (!byName && currentName.includes("自动选择")) {
        byName = currentName;
      }
      continue;
    }

    if (/^    type:\s*/.test(line)) {
      const type = stripWrappedQuotes(line.replace(/^    type:\s*/, ""));
      if (!byType && (type === "url-test" || type === "fallback" || type === "load-balance") && currentName) {
        byType = currentName;
      }
    }
  }

  return byName || byType;
}

function hasNodeNameConflict(lines, nodeName) {
  for (const line of lines) {
    if (!/^  - name:\s*/.test(line)) {
      continue;
    }
    const name = stripWrappedQuotes(line.replace(/^  - name:\s*/, ""));
    if (name === nodeName) {
      return true;
    }
  }
  return false;
}

function transformYaml(sourceText, config) {
  const hasTrailingNewline = sourceText.endsWith("\n");
  const lines = sourceText.replace(/\r\n/g, "\n").split("\n");

  const hasProxies = lines.some((line) => /^proxies:\s*$/.test(line));
  const hasProxyGroups = lines.some((line) => /^proxy-groups:\s*$/.test(line));
  if (!hasProxies) {
    fail("订阅内容中未找到 proxies 段");
  }
  if (!hasProxyGroups) {
    fail("订阅内容中未找到 proxy-groups 段");
  }

  if (hasNodeNameConflict(lines, config.newNodeName)) {
    fail(`节点名已存在: ${config.newNodeName}，请修改 NEW_NODE_NAME`);
  }

  const dialerGroup = detectDialerGroup(lines);
  if (!dialerGroup) {
    fail("未找到可用的自动选择代理组（name 包含“自动选择”或 type 为 url-test/fallback/load-balance）");
  }

  const out = [];
  let insertedProxyNode = false;
  let insertedFirstGroupRef = false;
  let inGroups = false;
  let seenFirstGroup = false;
  let inFirstGroup = false;

  for (const line of lines) {
    if (!insertedProxyNode && /^proxies:\s*$/.test(line)) {
      out.push(line);
      out.push(`  - name: ${config.newNodeName}`);
      out.push("    type: socks5");
      out.push(`    server: ${config.proxy.ip}`);
      out.push(`    port: ${config.proxy.port}`);
      out.push(`    username: ${config.proxy.username}`);
      out.push(`    password: ${config.proxy.password}`);
      out.push(`    dialer-proxy: ${dialerGroup}`);
      insertedProxyNode = true;
      continue;
    }

    if (/^proxy-groups:\s*$/.test(line)) {
      inGroups = true;
    } else if (inGroups && /^[^\s]/.test(line)) {
      if (inFirstGroup && !insertedFirstGroupRef) {
        out.push("    proxies:");
        out.push(`      - ${config.newNodeName}`);
        insertedFirstGroupRef = true;
      }
      inGroups = false;
      inFirstGroup = false;
    }

    if (inGroups) {
      if (!seenFirstGroup && /^  - name:\s*/.test(line)) {
        seenFirstGroup = true;
        inFirstGroup = true;
      } else if (seenFirstGroup && inFirstGroup && /^  - name:\s*/.test(line)) {
        if (!insertedFirstGroupRef) {
          out.push("    proxies:");
          out.push(`      - ${config.newNodeName}`);
          insertedFirstGroupRef = true;
        }
        inFirstGroup = false;
      }

      if (inFirstGroup && !insertedFirstGroupRef && /^    proxies:\s*$/.test(line)) {
        out.push(line);
        out.push(`      - ${config.newNodeName}`);
        insertedFirstGroupRef = true;
        continue;
      }
    }

    out.push(line);
  }

  if (inGroups && inFirstGroup && !insertedFirstGroupRef) {
    out.push("    proxies:");
    out.push(`      - ${config.newNodeName}`);
    insertedFirstGroupRef = true;
  }

  if (!insertedProxyNode || !insertedFirstGroupRef) {
    fail("生成新 YAML 失败（可能未正确识别 proxies 或第一个 proxy-group）");
  }

  const body = out.join("\n");
  return {
    body: hasTrailingNewline ? `${body}\n` : body,
    dialerGroup,
  };
}

async function fetchTextWithTimeout(url, timeoutMs, headers = {}, errorPrefix = "请求失败") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      fail(`${errorPrefix}，HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(pidFile) {
  if (!fs.existsSync(pidFile)) {
    return null;
  }
  const raw = fs.readFileSync(pidFile, "utf8").trim();
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

function getPidFilePath() {
  if (!PID_FILE) {
    fail("PID_FILE 不能为空");
  }
  return PID_FILE;
}

function removePidFileIfOwned(pidFile, expectedPid) {
  const pidInFile = readPidFile(pidFile);
  if (pidInFile === expectedPid && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
}

function saveCurrentPid(pidFile) {
  const existingPid = readPidFile(pidFile);
  if (existingPid && isProcessRunning(existingPid)) {
    fail(`服务已在运行，PID=${existingPid}，如需停止请执行: node subscription_bridge_server.js stop`);
  }
  if (existingPid && !isProcessRunning(existingPid) && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function buildTokenHint(cfg) {
  return cfg.bToken ? `?token=${encodeURIComponent(cfg.bToken)}` : "";
}

function normalizePath(p) {
  return p.startsWith("/") ? p : `/${p}`;
}

function isWildcardListenHost(host) {
  return host === "0.0.0.0" || host === "::";
}

function extractIpv4(text) {
  const m = (text || "").match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (!m) {
    return "";
  }
  const ip = m[0];
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4) {
    return "";
  }
  if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return "";
  }
  return ip;
}

async function detectPublicIp(timeoutMs) {
  const urls = [
    "https://api.ipify.org",
    "https://ifconfig.me/ip",
    "https://ipv4.icanhazip.com",
  ];

  for (const u of urls) {
    try {
      const body = await fetchTextWithTimeout(
        u,
        timeoutMs,
        { "user-agent": "subscription-bridge/1.0", accept: "text/plain,*/*" },
        "探测公网 IP 失败"
      );
      const ip = extractIpv4(body.trim());
      if (ip) {
        return ip;
      }
    } catch {
      // 尝试下一个探测源
    }
  }
  return "";
}

async function resolveSubscriptionLink(cfg, options = {}) {
  const tokenHint = buildTokenHint(cfg);
  const normalizedPath = normalizePath(cfg.bPath);

  if (cfg.publicBaseUrl) {
    const base = cfg.publicBaseUrl.replace(/\/+$/, "");
    return `${base}${normalizedPath}${tokenHint}`;
  }

  let hostForLink = cfg.host;
  if (isWildcardListenHost(cfg.host)) {
    const publicIp = await detectPublicIp(cfg.publicIpDetectTimeoutMs);
    if (!publicIp) {
      if (options.allowPlaceholder) {
        return "(无法自动探测公网IP，请设置 PUBLIC_BASE_URL)";
      }
      fail("无法自动探测公网IP，请设置 PUBLIC_BASE_URL（例如 http://你的公网IP:8090）");
    }
    hostForLink = publicIp;
  }

  return `http://${hostForLink}:${cfg.port}${normalizedPath}${tokenHint}`;
}

function createRuntimeConfig() {
  const subscriptionUrlA = SUBSCRIPTION_URL_A;
  const newProxyInfo = NEW_PROXY_INFO;
  const newNodeName = NEW_NODE_NAME;
  const host = HOST;
  const port = Number(PORT);
  const bPath = B_PATH;
  const publicBaseUrl = PUBLIC_BASE_URL.trim();
  const bToken = B_TOKEN;
  const fetchTimeoutMs = Number(FETCH_TIMEOUT_MS);
  const publicIpDetectTimeoutMs = Number(PUBLIC_IP_DETECT_TIMEOUT_MS);
  const upstreamAuthHeader = UPSTREAM_AUTH_HEADER;
  const pidFile = PID_FILE;

  if (!subscriptionUrlA || !/^https?:\/\//.test(subscriptionUrlA)) {
    fail("请设置 SUBSCRIPTION_URL_A，且必须为 http/https 链接");
  }
  if (!newProxyInfo) {
    fail("请设置 NEW_PROXY_INFO，格式为 IP:PORT:USER:PASSWORD");
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    fail("PORT 必须是 1-65535 的整数");
  }
  if (!bPath.startsWith("/")) {
    fail("B_PATH 必须以 / 开头，例如 /sub");
  }
  if (publicBaseUrl && !/^https?:\/\//.test(publicBaseUrl)) {
    fail("PUBLIC_BASE_URL 必须是 http/https 链接，或留空");
  }
  if (!Number.isFinite(fetchTimeoutMs) || fetchTimeoutMs < 1000) {
    fail("FETCH_TIMEOUT_MS 不能小于 1000");
  }
  if (!Number.isFinite(publicIpDetectTimeoutMs) || publicIpDetectTimeoutMs < 500) {
    fail("PUBLIC_IP_DETECT_TIMEOUT_MS 不能小于 500");
  }
  if (!pidFile) {
    fail("PID_FILE 不能为空");
  }
  if (!LOG_FILE) {
    fail("LOG_FILE 不能为空");
  }

  return {
    subscriptionUrlA,
    proxy: parseProxyInfo(newProxyInfo),
    newNodeName,
    host,
    port,
    bPath,
    publicBaseUrl,
    bToken,
    fetchTimeoutMs,
    publicIpDetectTimeoutMs,
    upstreamAuthHeader,
    pidFile,
  };
}

async function handleSubscriptionRequest(req, res, cfg) {
  const start = Date.now();
  const remoteIp = req.socket?.remoteAddress || "unknown";
  const reqMethod = req.method || "UNKNOWN";
  const reqPath = req.url || "/";
  let statusCode = 500;
  let detail = "";
  const reply = (status, body, headers = {}) => {
    statusCode = status;
    send(res, status, body, headers);
  };

  try {
    if (req.method !== "GET") {
      detail = "method_not_allowed";
      reply(405, "Method Not Allowed");
      return;
    }

    const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (reqUrl.pathname !== cfg.bPath) {
      detail = "path_not_match";
      reply(404, "Not Found");
      return;
    }

    if (cfg.bToken) {
      const tokenFromQuery = reqUrl.searchParams.get("token") || "";
      const tokenFromHeader = (req.headers["x-sub-token"] || "").toString();
      if (tokenFromQuery !== cfg.bToken && tokenFromHeader !== cfg.bToken) {
        detail = "unauthorized";
        reply(401, "Unauthorized");
        return;
      }
    }

    const headers = {
      "user-agent": "subscription-bridge/1.0",
      accept: "*/*",
    };
    if (cfg.upstreamAuthHeader) {
      headers.authorization = cfg.upstreamAuthHeader;
    }

    const source = await fetchTextWithTimeout(cfg.subscriptionUrlA, cfg.fetchTimeoutMs, headers, "拉取订阅 A 失败");
    const transformed = transformYaml(source, {
      proxy: cfg.proxy,
      newNodeName: cfg.newNodeName,
    });

    detail = `ok dialer=${transformed.dialerGroup}`;
    reply(200, transformed.body, {
      "content-type": "application/yaml; charset=utf-8",
      "cache-control": "no-store",
      "x-dialer-proxy-group": encodeURIComponent(transformed.dialerGroup),
    });
  } catch (error) {
    detail = `error=${(error.message || String(error)).replace(/\s+/g, " ").slice(0, 300)}`;
    reply(500, `Internal Error: ${error.message || String(error)}`);
  } finally {
    const costMs = Date.now() - start;
    logInfo(`REQ ${remoteIp} "${reqMethod} ${reqPath}" ${statusCode} ${costMs}ms ${detail}`);
  }
}

async function startServer() {
  const cfg = createRuntimeConfig();
  const subscriptionLink = await resolveSubscriptionLink(cfg);
  saveCurrentPid(cfg.pidFile);

  let stopping = false;

  const server = http.createServer((req, res) => {
    handleSubscriptionRequest(req, res, cfg);
  });

  const shutdown = (signalName) => {
    if (stopping) {
      return;
    }
    stopping = true;
    logWarn(`收到 ${signalName}，正在停止服务...`);

    server.close(() => {
      removePidFileIfOwned(cfg.pidFile, process.pid);
      logInfo("服务已停止");
      process.exit(0);
    });

    // 兜底超时，避免 server.close 长时间不返回
    setTimeout(() => {
      removePidFileIfOwned(cfg.pidFile, process.pid);
      process.exit(1);
    }, 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(cfg.port, cfg.host, () => {
    logInfo(`进程 PID: ${process.pid}`);
    logInfo("订阅中转服务已启动");
    logInfo(`订阅链接 B: ${subscriptionLink}`);
    logInfo(`日志文件: ${LOG_FILE}`);
    logInfo(`上游订阅 A: ${cfg.subscriptionUrlA}`);
    logInfo(`停止命令: node subscription_bridge_server.js stop`);
    logInfo(`状态命令: node subscription_bridge_server.js status`);
  });

  server.on("error", (err) => {
    removePidFileIfOwned(cfg.pidFile, process.pid);
    logError(`服务启动失败: ${err.message || String(err)}`);
    process.exit(1);
  });
}

function stopServer() {
  const pidFile = getPidFilePath();
  const pid = readPidFile(pidFile);
  if (!pid) {
    logInfo("服务未运行（未找到 PID 文件）");
    return;
  }
  if (!isProcessRunning(pid)) {
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
    logWarn(`检测到过期 PID(${pid})，已清理 PID 文件`);
    return;
  }

  process.kill(pid, "SIGTERM");
  logInfo(`已向 PID ${pid} 发送停止信号(SIGTERM)`);
}

async function showStatus() {
  const pidFile = getPidFilePath();
  const pid = readPidFile(pidFile);

  let subscriptionLink = "";
  try {
    subscriptionLink = await resolveSubscriptionLink(createRuntimeConfig(), { allowPlaceholder: true });
  } catch {
    subscriptionLink = "(配置不完整，暂无法生成链接)";
  }

  if (pid && isProcessRunning(pid)) {
    logInfo("服务状态: 运行中");
    logInfo(`PID: ${pid}`);
    logInfo(`订阅链接 B: ${subscriptionLink}`);
    return;
  }

  if (pid && !isProcessRunning(pid) && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
  logInfo("服务状态: 未运行");
  logInfo(`订阅链接 B: ${subscriptionLink}`);
}

async function showLink() {
  const cfg = createRuntimeConfig();
  console.log(await resolveSubscriptionLink(cfg));
}

// 命令:
// 1) start(默认): 启动服务
// 2) stop: 停止服务（按 PID_FILE）
// 3) status: 查看服务状态
// 4) link: 输出订阅链接 B
// 5) --transform-local <inputYamlPath> <outputYamlPath>: 本地改写测试（不启动服务）
const command = process.argv[2] || "start";

async function main() {
  if (command === "--transform-local") {
    const inputPath = process.argv[3];
    const outputPath = process.argv[4];
    if (!inputPath || !outputPath) {
      console.error("用法: node subscription_bridge_server.js --transform-local <inputYamlPath> <outputYamlPath>");
      process.exit(1);
    }
    try {
      const cfg = createRuntimeConfig();
      const source = fs.readFileSync(inputPath, "utf8");
      const transformed = transformYaml(source, {
        proxy: cfg.proxy,
        newNodeName: cfg.newNodeName,
      });
      fs.writeFileSync(outputPath, transformed.body, "utf8");
      console.log(`本地改写完成: ${outputPath}`);
      console.log(`dialer-proxy 使用代理组: ${transformed.dialerGroup}`);
      return;
    } catch (error) {
      console.error(`失败: ${error.message || String(error)}`);
      process.exit(1);
    }
  }

  if (command === "start") {
    try { 
      await startServer();
      return;
    } catch (error) {
      console.error(`启动失败: ${error.message || String(error)}`);
      process.exit(1);
    }
  }

  if (command === "stop") {
    try {
      stopServer();
      return;
    } catch (error) {
      console.error(`停止失败: ${error.message || String(error)}`);
      process.exit(1);
    }
  }

  if (command === "status") {
    try {
      await showStatus();
      return;
    } catch (error) {
      console.error(`状态检查失败: ${error.message || String(error)}`);
      process.exit(1);
    }
  }

  if (command === "link") {
    try {
      await showLink();
      return;
    } catch (error) {
      console.error(`输出链接失败: ${error.message || String(error)}`);
      process.exit(1);
    }
  }

  console.error("未知命令。可用命令: start | stop | status | link | --transform-local");
  process.exit(1);
}

main();

module.exports = {
  transformYaml,
  detectDialerGroup,
};
