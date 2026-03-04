#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { createLogger } = require("./bridge/logger");
const { buildRegistry } = require("./bridge/registry");
const { resolveSubscriptionLinkDetail } = require("./bridge/link_utils");
const { fetchTextWithTimeout, extractClashYaml, stripBom } = require("./bridge/upstream_parser");
const { transformYaml } = require("./bridge/yaml_transform");

const SCRIPT_FILE = path.basename(__filename);
const SCRIPT_STEM = SCRIPT_FILE.replace(/\.[^.]+$/, "");
const SELF_NODE_CMD = `node "${SCRIPT_FILE}"`;
function selfNodeCommand(args = "") {
  return args ? `${SELF_NODE_CMD} ${args}` : SELF_NODE_CMD;
}

/*
功能概述:
1) 从 proxy/subscription.csv 读取多组 A 订阅 + B_TOKEN。
2) 从 proxy/proxy.csv 读取多条链式代理节点（socks5）。
3) 为每组 A/B_TOKEN 生成一条订阅链接 B。
4) 当客户端请求某个 B(token=xxx) 时，只拉取对应的 A，不会拉取其他 A。
5) 解析或改写失败的组合会在启动预检阶段被跳过。

CSV 格式:
1) proxy/subscription.csv（必填列）
   - id,a_url,b_token,enabled
   - id: 可选，留空自动生成
   - a_url: A 订阅链接
   - b_token: B 链接 token（必须唯一）
   - enabled: 可选，1/0/true/false，默认 true
2) proxy/proxy.csv（必填列）
   - name,server,port,username,password,enabled
   - enabled: 可选，1/0/true/false，默认 true
*/

// ===== 用户手动填写 =====
const SUBSCRIPTION_CSV_FILE = path.resolve(__dirname, "proxy", "subscription.csv");
const PROXY_CSV_FILE = path.resolve(__dirname, "proxy", "proxy.csv");

const HOST = "0.0.0.0";
const PORT = 8090;
const B_PATH = "/sub";
const PUBLIC_BASE_URL = "";

const FETCH_TIMEOUT_MS = 20000;
const PUBLIC_IP_DETECT_TIMEOUT_MS = 3500;
const UPSTREAM_AUTH_HEADER = "";
const PRECHECK_ON_START = true;

const PID_FILE = path.resolve(__dirname, `${SCRIPT_STEM}.pid`);
const LOG_DIR = path.resolve(__dirname, "logs");
const LOG_FILE = path.resolve(LOG_DIR, `${SCRIPT_STEM}.log`);
// ======================

function fail(message) {
  throw new Error(message);
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

function removePidFileIfOwned(pidFile, expectedPid) {
  const pidInFile = readPidFile(pidFile);
  if (pidInFile === expectedPid && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
}

function saveCurrentPid(pidFile) {
  const existingPid = readPidFile(pidFile);
  if (existingPid && isProcessRunning(existingPid)) {
    fail(`服务已在运行，PID=${existingPid}，如需停止请执行: ${selfNodeCommand("stop")}`);
  }
  if (existingPid && !isProcessRunning(existingPid) && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function getRequestToken(req, reqUrl) {
  const tokenFromQuery = reqUrl.searchParams.get("token") || "";
  const tokenFromHeader = (req.headers["x-sub-token"] || "").toString();
  return tokenFromQuery || tokenFromHeader;
}

function createRuntimeConfig() {
  if (!Number.isFinite(PORT) || PORT <= 0 || PORT > 65535) {
    fail("PORT 必须是 1-65535 的整数");
  }
  if (!B_PATH.startsWith("/")) {
    fail("B_PATH 必须以 / 开头，例如 /sub");
  }
  if (PUBLIC_BASE_URL && !/^https?:\/\//.test(PUBLIC_BASE_URL)) {
    fail("PUBLIC_BASE_URL 必须是 http/https 链接，或留空");
  }
  if (!Number.isFinite(FETCH_TIMEOUT_MS) || FETCH_TIMEOUT_MS < 1000) {
    fail("FETCH_TIMEOUT_MS 不能小于 1000");
  }
  if (!Number.isFinite(PUBLIC_IP_DETECT_TIMEOUT_MS) || PUBLIC_IP_DETECT_TIMEOUT_MS < 500) {
    fail("PUBLIC_IP_DETECT_TIMEOUT_MS 不能小于 500");
  }
  if (!PID_FILE) {
    fail("PID_FILE 不能为空");
  }
  if (!LOG_FILE) {
    fail("LOG_FILE 不能为空");
  }
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  return {
    subscriptionCsvFile: SUBSCRIPTION_CSV_FILE,
    proxyCsvFile: PROXY_CSV_FILE,
    host: HOST,
    port: Number(PORT),
    bPath: B_PATH,
    publicBaseUrl: PUBLIC_BASE_URL.trim(),
    fetchTimeoutMs: Number(FETCH_TIMEOUT_MS),
    publicIpDetectTimeoutMs: Number(PUBLIC_IP_DETECT_TIMEOUT_MS),
    upstreamAuthHeader: UPSTREAM_AUTH_HEADER,
    precheckOnStart: PRECHECK_ON_START,
    pidFile: PID_FILE,
    logFile: LOG_FILE,
  };
}

async function buildLinkRows(cfg, registry, logger, allowPlaceholderLink) {
  const activeTokenMap = new Map();
  const links = [];
  const linkFailed = [];
  const sourceStats = new Map();

  for (const sub of registry.activeSubs) {
    try {
      const detail = await resolveSubscriptionLinkDetail(cfg, sub.token, { allowPlaceholder: !!allowPlaceholderLink });
      if (!detail.link || detail.link.startsWith("(")) {
        throw new Error(detail.link || "empty_link");
      }
      links.push({
        sub,
        link: detail.link,
        source: detail.source,
        host: detail.host,
      });
      activeTokenMap.set(sub.token, sub);
      sourceStats.set(detail.source, (sourceStats.get(detail.source) || 0) + 1);
    } catch (error) {
      linkFailed.push({
        sub,
        reason: error.message || String(error),
      });
      logger.warn(`跳过订阅 id=${sub.id} token=${sub.token} 原因: 生成 B 链接失败: ${error.message || String(error)}`);
    }
  }

  return {
    activeTokenMap,
    links,
    linkFailed,
    sourceStats,
  };
}

function formatLinkSource(source) {
  if (source === "public_base_url") {
    return "PUBLIC_BASE_URL";
  }
  if (source === "public_ip") {
    return "public_ip";
  }
  if (source === "lan_ip") {
    return "lan_ip";
  }
  if (source === "listen_host") {
    return "listen_host";
  }
  return source || "unknown";
}

async function startServer() {
  const cfg = createRuntimeConfig();
  const logger = createLogger(cfg.logFile);
  const registry = await buildRegistry(cfg, logger);
  const linkResult = await buildLinkRows(cfg, registry, logger, false);

  if (linkResult.activeTokenMap.size === 0) {
    fail("没有可用的订阅组合（可能全部预检失败或链接生成失败）");
  }

  saveCurrentPid(cfg.pidFile);
  let stopping = false;

  const server = http.createServer(async (req, res) => {
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

      const token = getRequestToken(req, reqUrl);
      if (!token) {
        detail = "missing_token";
        reply(401, "Unauthorized: missing token");
        return;
      }

      const sub = linkResult.activeTokenMap.get(token);
      if (!sub) {
        detail = "token_not_found";
        reply(401, "Unauthorized: invalid token");
        return;
      }

      const headers = {
        "user-agent": "subscription-bridge/1.0",
        accept: "*/*",
      };
      if (cfg.upstreamAuthHeader) {
        headers.authorization = cfg.upstreamAuthHeader;
      }

      const source = await fetchTextWithTimeout(sub.aUrl, cfg.fetchTimeoutMs, headers, `拉取订阅 A(${sub.id}) 失败`);

      // 加载模板文件（如果配置了）
      let templateYaml = "";
      if (sub.template && sub.template.toLowerCase() !== "none") {
        // subscription_bridge_server.js 在服务根目录，不需要跳到上一级(..)
        const templatePath = path.resolve(__dirname, sub.template);
        if (fs.existsSync(templatePath)) {
          templateYaml = fs.readFileSync(templatePath, "utf8");
        }
      }

      const extracted = extractClashYaml(source, templateYaml);
      if (!extracted) {
        const snippet = stripBom(source || "").replace(/\s+/g, " ").slice(0, 200);
        fail(`上游响应无法识别为 Clash YAML（id=${sub.id}），片段: ${snippet}`);
      }

      const transformed = transformYaml(extracted.yaml, registry.proxyNodes);

      // 保存生成的配置文件
      const outputPath = path.resolve(__dirname, "output");
      if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
      }
      const savedFilePath = path.join(outputPath, `sub_${sub.id}.yaml`);
      fs.writeFileSync(savedFilePath, transformed.body, "utf8");

      detail = `ok id=${sub.id} mode=${extracted.mode} dialer=${transformed.dialerGroup} added=${transformed.addedNodeNames.length} savedTo=${savedFilePath}`;

      reply(200, transformed.body, {
        "content-type": "application/yaml; charset=utf-8",
        "cache-control": "no-store",
        "x-dialer-proxy-group": encodeURIComponent(transformed.dialerGroup),
        "x-subscription-id": sub.id,
      });
    } catch (error) {
      detail = `error=${(error.message || String(error)).replace(/\s+/g, " ").slice(0, 260)}`;
      reply(500, `Internal Error: ${error.message || String(error)}`);
    } finally {
      const costMs = Date.now() - start;
      logger.info(`REQ ${remoteIp} "${reqMethod} ${reqPath}" ${statusCode} ${costMs}ms ${detail}`);
    }
  });

  const shutdown = (signalName) => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.warn(`收到 ${signalName}，正在停止服务...`);
    server.close(() => {
      removePidFileIfOwned(cfg.pidFile, process.pid);
      logger.info("服务已停止");
      process.exit(0);
    });
    setTimeout(() => {
      removePidFileIfOwned(cfg.pidFile, process.pid);
      process.exit(1);
    }, 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(cfg.port, cfg.host, () => {
    logger.info(`进程 PID: ${process.pid}`);
    logger.info("订阅中转服务已启动");
    logger.info(`日志文件: ${cfg.logFile}`);
    logger.info(`已加载代理节点数量: ${registry.proxyNodes.length}`);
    logger.info(`订阅预检: active=${registry.activeSubs.length}, skipped=${registry.skippedSubs.length}, link_failed=${linkResult.linkFailed.length}`);

    if (linkResult.sourceStats.size > 0) {
      const summary = Array.from(linkResult.sourceStats.entries())
        .map(([source, count]) => `${formatLinkSource(source)}=${count}`)
        .join(", ");
      logger.info(`订阅链接地址来源统计: ${summary}`);
    }

    for (const row of linkResult.links) {
      const hostSuffix = row.host ? `, host=${row.host}` : "";
      logger.info(`订阅链接 B [id=${row.sub.id}, token=${row.sub.token}] => ${row.link} (source=${formatLinkSource(row.source)}${hostSuffix})`);
    }
    logger.info(`停止命令: ${selfNodeCommand("stop")}`);
    logger.info(`状态命令: ${selfNodeCommand("status")}`);
  });

  server.on("error", (err) => {
    removePidFileIfOwned(cfg.pidFile, process.pid);
    logger.error(`服务启动失败: ${err.message || String(err)}`);
    process.exit(1);
  });
}

function stopServer() {
  const cfg = createRuntimeConfig();
  const logger = createLogger(cfg.logFile);
  const pid = readPidFile(cfg.pidFile);

  if (!pid) {
    logger.info("服务未运行（未找到 PID 文件）");
    return;
  }
  if (!isProcessRunning(pid)) {
    if (fs.existsSync(cfg.pidFile)) {
      fs.unlinkSync(cfg.pidFile);
    }
    logger.warn(`检测到过期 PID(${pid})，已清理 PID 文件`);
    return;
  }
  process.kill(pid, "SIGTERM");
  logger.info(`已向 PID ${pid} 发送停止信号(SIGTERM)`);
}

async function showStatus() {
  const cfg = createRuntimeConfig();
  const logger = createLogger(cfg.logFile);
  const pid = readPidFile(cfg.pidFile);
  const running = !!(pid && isProcessRunning(pid));

  const registry = await buildRegistry(cfg, logger);
  const linkResult = await buildLinkRows(cfg, registry, logger, true);

  if (!running && pid && fs.existsSync(cfg.pidFile)) {
    fs.unlinkSync(cfg.pidFile);
  }

  logger.info(`服务状态: ${running ? "运行中" : "未运行"}`);
  if (running) {
    logger.info(`PID: ${pid}`);
  }
  logger.info(`订阅组合: active=${registry.activeSubs.length}, skipped=${registry.skippedSubs.length}, link_failed=${linkResult.linkFailed.length}`);
  for (const row of linkResult.links) {
    const hostSuffix = row.host ? `, host=${row.host}` : "";
    logger.info(`B [id=${row.sub.id}, token=${row.sub.token}] => ${row.link} (source=${formatLinkSource(row.source)}${hostSuffix})`);
  }
}

async function showLinks() {
  const cfg = createRuntimeConfig();
  const logger = createLogger(cfg.logFile);
  const registry = await buildRegistry(cfg, logger);
  const linkResult = await buildLinkRows(cfg, registry, logger, false);

  for (const row of linkResult.links) {
    console.log(`${row.sub.id},${row.sub.token},${row.link}`);
  }
}

async function testTransformLocal(inputPath, outputPath) {
  const cfg = createRuntimeConfig();
  const logger = createLogger(cfg.logFile);
  const registry = await buildRegistry(
    {
      ...cfg,
      precheckOnStart: false,
    },
    logger
  );

  const source = fs.readFileSync(inputPath, "utf8");
  const extracted = extractClashYaml(source);
  if (!extracted) {
    fail("输入文件无法识别为 Clash YAML");
  }
  const transformed = transformYaml(extracted.yaml, registry.proxyNodes);
  fs.writeFileSync(outputPath, transformed.body, "utf8");
  console.log(`本地改写完成: ${outputPath}`);
  console.log(`dialer-proxy 使用代理组: ${transformed.dialerGroup}`);
  console.log(`新增节点: ${transformed.addedNodeNames.join(",")}`);
}

const command = process.argv[2] || "start";

async function main() {
  if (command === "--transform-local") {
    const inputPath = process.argv[3];
    const outputPath = process.argv[4];
    if (!inputPath || !outputPath) {
      console.error(`用法: ${selfNodeCommand("--transform-local <inputYamlPath> <outputYamlPath>")}`);
      process.exit(1);
    }
    try {
      await testTransformLocal(inputPath, outputPath);
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
      await showLinks();
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
