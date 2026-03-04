"use strict";

const fs = require("node:fs");

function fail(message) {
  throw new Error(message);
}

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((x) => x.trim());
}

function parseCsv(text) {
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
  const meaningful = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (meaningful.length === 0) {
    return [];
  }

  const headers = parseCsvLine(meaningful[0]).map((h) => h.trim());
  if (headers.length === 0 || headers.every((h) => !h)) {
    return [];
  }

  const rows = [];
  for (let i = 1; i < meaningful.length; i += 1) {
    const cells = parseCsvLine(meaningful[i]);
    const row = {};
    for (let c = 0; c < headers.length; c += 1) {
      const key = headers[c];
      if (!key) {
        continue;
      }
      row[key] = cells[c] != null ? cells[c] : "";
    }
    rows.push(row);
  }
  return rows;
}

function pick(row, aliases) {
  for (const k of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      const v = `${row[k] || ""}`.trim();
      if (v) {
        return v;
      }
    }
  }
  return "";
}

function parseBoolean(text, defaultValue) {
  const raw = `${text || ""}`.trim().toLowerCase();
  if (!raw) {
    return defaultValue;
  }
  if (["1", "true", "yes", "y", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(raw)) {
    return false;
  }
  return defaultValue;
}

function loadSubscriptionsCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`订阅配置文件不存在: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const rows = parseCsv(raw);
  if (rows.length === 0) {
    fail(`订阅配置为空: ${filePath}`);
  }

  const out = [];
  const tokenSet = new Set();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const lineNo = i + 2;
    const id = pick(row, ["id"]) || `sub${i + 1}`;
    const aUrl = pick(row, ["a_url", "subscription_url", "url", "a"]);
    const token = pick(row, ["b_token", "token", "btoken"]);
    const enabled = parseBoolean(pick(row, ["enabled"]), true);
    const template = pick(row, ["template"]);

    if (!aUrl) {
      fail(`subscription.csv 第 ${lineNo} 行缺少 A 订阅链接（a_url/subscription_url/url）`);
    }
    if (!/^https?:\/\//.test(aUrl)) {
      fail(`subscription.csv 第 ${lineNo} 行 A 订阅链接格式错误: ${aUrl}`);
    }
    if (!token) {
      fail(`subscription.csv 第 ${lineNo} 行缺少 B_TOKEN（b_token/token）`);
    }
    if (tokenSet.has(token)) {
      fail(`subscription.csv 中存在重复 B_TOKEN: ${token}`);
    }
    tokenSet.add(token);

    out.push({
      id,
      aUrl,
      token,
      enabled,
      template,
      lineNo,
    });
  }

  return out;
}

function loadProxyCsv(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`代理节点配置文件不存在: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const rows = parseCsv(raw);
  if (rows.length === 0) {
    fail(`代理节点配置为空: ${filePath}`);
  }

  const out = [];
  const nameSet = new Set();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const lineNo = i + 2;
    const enabled = parseBoolean(pick(row, ["enabled"]), true);
    if (!enabled) {
      continue;
    }

    const name = pick(row, ["name"]);
    const server = pick(row, ["server", "ip", "host"]);
    const portStr = pick(row, ["port"]);
    const username = pick(row, ["username", "user"]);
    const password = pick(row, ["password", "pass"]);
    const type = pick(row, ["type"]) || "socks5";

    if (!name) {
      fail(`proxy.csv 第 ${lineNo} 行缺少 name`);
    }
    if (nameSet.has(name)) {
      fail(`proxy.csv 中存在重复节点名称: ${name}`);
    }
    nameSet.add(name);

    if (!server) {
      fail(`proxy.csv 第 ${lineNo} 行缺少 server/ip`);
    }
    if (!portStr || !/^\d+$/.test(portStr)) {
      fail(`proxy.csv 第 ${lineNo} 行端口格式错误: ${portStr}`);
    }
    const port = Number(portStr);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      fail(`proxy.csv 第 ${lineNo} 行端口超出范围: ${portStr}`);
    }
    if (type === "socks5" && !username) {
      fail(`proxy.csv 第 ${lineNo} 行 socks5 类型缺少 username`);
    }
    if (type === "socks5" && !password) {
      fail(`proxy.csv 第 ${lineNo} 行 socks5 类型缺少 password`);
    }

    out.push({
      name,
      server,
      port,
      username,
      password,
      type,
      lineNo,
    });
  }

  if (out.length === 0) {
    fail("proxy.csv 中没有可用的代理节点（可能都被 enabled=0 禁用）");
  }
  return out;
}

module.exports = {
  loadSubscriptionsCsv,
  loadProxyCsv,
};

