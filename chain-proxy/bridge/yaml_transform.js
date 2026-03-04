"use strict";

const { stripBom, isTopLevelKeyLine } = require("./upstream_parser");

function fail(message) {
  throw new Error(message);
}

function stripWrappedQuotes(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function detectDialerGroup(lines) {
  let inGroups = false;
  let currentName = "";
  let byName = "";
  let byType = "";

  for (const line of lines) {
    if (isTopLevelKeyLine(line, "proxy-groups")) {
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

function collectExistingNames(lines) {
  const set = new Set();
  for (const line of lines) {
    if (!/^  - name:\s*/.test(line)) {
      continue;
    }
    const name = stripWrappedQuotes(line.replace(/^  - name:\s*/, ""));
    if (name) {
      set.add(name);
    }
  }
  return set;
}

function hasSshDirectRule(lines) {
  for (const line of lines) {
    const compact = line.replace(/\s+/g, "");
    if (/^-DST-PORT,22,DIRECT(?:,[^#]+)?(?:#.*)?$/.test(compact)) {
      return true;
    }
  }
  return false;
}

function buildProxyYamlLines(node, dialerProxy) {
  const lines = [];
  lines.push(`  - name: ${node.name}${dialerProxy ? "-Chain" : ""}`);
  lines.push(`    type: ${node.type || "socks5"}`);
  lines.push(`    server: ${node.server}`);
  lines.push(`    port: ${node.port}`);
  if (node.username) {
    lines.push(`    username: ${node.username}`);
  }
  if (node.password) {
    lines.push(`    password: ${node.password}`);
  }
  if ((node.type || "socks5") === "socks5") {
    lines.push("    udp: true");
  }
  if (dialerProxy) {
    lines.push(`    dialer-proxy: ${dialerProxy}`);
  }
  return lines;
}

function transformYaml(sourceText, proxyNodes) {
  const normalizedSource = stripBom(sourceText || "");
  const hasTrailingNewline = normalizedSource.endsWith("\n");
  const lines = normalizedSource.replace(/\r\n/g, "\n").split("\n");

  const hasProxies = lines.some((line) => isTopLevelKeyLine(line, "proxies"));
  const hasProxyGroups = lines.some((line) => isTopLevelKeyLine(line, "proxy-groups"));
  if (!hasProxies) {
    fail("订阅内容中未找到 proxies 段");
  }
  if (!hasProxyGroups) {
    fail("订阅内容中未找到 proxy-groups 段");
  }

  const dialerGroup = detectDialerGroup(lines);
  if (!dialerGroup) {
    fail('未找到可用的自动选择代理组（name 包含"自动选择"或 type 为 url-test/fallback/load-balance）');
  }

  const existingNames = collectExistingNames(lines);
  const addedNodes = [];
  const skippedNodes = [];
  for (const node of proxyNodes) {
    const chainName = `${node.name}-Chain`;
    if (existingNames.has(node.name) && existingNames.has(chainName)) {
      skippedNodes.push(node.name);
      continue;
    }
    existingNames.add(node.name);
    existingNames.add(chainName);
    addedNodes.push(node);
  }
  if (addedNodes.length === 0) {
    fail("所有待加入代理节点名称都已存在，无法新增");
  }

  // 构建所有新增节点的名称列表（独立 + 链式）
  const allNewNames = [];
  for (const node of addedNodes) {
    allNewNames.push(node.name);
    allNewNames.push(`${node.name}-Chain`);
  }

  const alreadyHasSshDirectRule = hasSshDirectRule(lines);
  const out = [];
  let insertedProxyNodes = false;
  let insertedFirstGroupRef = false;
  let insertedSshDirectRule = alreadyHasSshDirectRule;
  let inGroups = false;
  let inRules = false;
  let seenFirstGroup = false;
  let inFirstGroup = false;

  for (const line of lines) {
    if (!insertedSshDirectRule && isTopLevelKeyLine(line, "rules")) {
      inRules = true;
      out.push(line);
      out.push("  - DST-PORT,22,DIRECT");
      insertedSshDirectRule = true;
      continue;
    }

    if (inRules && /^[^\s]/.test(line)) {
      inRules = false;
    }

    if (!insertedProxyNodes && isTopLevelKeyLine(line, "proxies")) {
      out.push(line);
      for (const node of addedNodes) {
        // 独立代理节点（不带 dialer-proxy）
        for (const l of buildProxyYamlLines(node, null)) {
          out.push(l);
        }
        // 链式代理节点（带 dialer-proxy）
        for (const l of buildProxyYamlLines(node, dialerGroup)) {
          out.push(l);
        }
      }
      insertedProxyNodes = true;
      continue;
    }

    if (isTopLevelKeyLine(line, "proxy-groups")) {
      inGroups = true;
    } else if (inGroups && /^[^\s]/.test(line)) {
      if (inFirstGroup && !insertedFirstGroupRef) {
        out.push("    proxies:");
        for (const n of allNewNames) {
          out.push(`      - ${n}`);
        }
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
          for (const n of allNewNames) {
            out.push(`      - ${n}`);
          }
          insertedFirstGroupRef = true;
        }
        inFirstGroup = false;
      }

      if (inFirstGroup && !insertedFirstGroupRef && /^    proxies:\s*$/.test(line)) {
        out.push(line);
        for (const n of allNewNames) {
          out.push(`      - ${n}`);
        }
        insertedFirstGroupRef = true;
        continue;
      }
    }

    out.push(line);
  }

  if (inGroups && inFirstGroup && !insertedFirstGroupRef) {
    out.push("    proxies:");
    for (const n of allNewNames) {
      out.push(`      - ${n}`);
    }
    insertedFirstGroupRef = true;
  }

  if (!insertedSshDirectRule) {
    out.push("rules:");
    out.push("  - DST-PORT,22,DIRECT");
    insertedSshDirectRule = true;
  }

  if (!insertedProxyNodes || !insertedFirstGroupRef || !insertedSshDirectRule) {
    fail("生成新 YAML 失败（可能未正确识别 proxies 或第一个 proxy-group）");
  }

  const body = out.join("\n");
  return {
    body: hasTrailingNewline ? `${body}\n` : body,
    dialerGroup,
    addedNodeNames: addedNodes.map((n) => n.name),
    skippedNodeNames: skippedNodes,
  };
}

module.exports = {
  transformYaml,
};

