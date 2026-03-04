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

/**
 * 从 flow-style 行（如 `  - { name: XX, type: YY, ... }`）中提取指定字段。
 * 返回字段值或空字符串。
 */
function extractFlowField(line, field) {
  // 匹配 field: value 或 field: 'value' 或 field: "value"
  const re = new RegExp(`[{,]\\s*${field}:\\s*([^,}]+)`);
  const m = line.match(re);
  if (!m) {
    return "";
  }
  return stripWrappedQuotes(m[1]);
}

/**
 * 判断一行是否是 proxy-groups 段内的列表项。
 * 支持 block-style (`  - name: XX`) 和 flow-style (`  - { name: XX, ... }`)。
 */
function isGroupItemLine(line) {
  return /^\s+- name:\s*/.test(line) || /^\s+-\s*\{.*name:/.test(line);
}

/**
 * 从一行中提取 proxy-group 的 name。
 * 支持 block-style 和 flow-style。
 */
function extractGroupName(line) {
  // block-style: `  - name: XX`
  if (/^\s+- name:\s*/.test(line) && !/\{/.test(line)) {
    return stripWrappedQuotes(line.replace(/^\s+- name:\s*/, ""));
  }
  // flow-style: `  - { name: XX, ... }`
  return extractFlowField(line, "name");
}

/**
 * 从一行中提取 proxy-group 的 type。
 * block-style 的 type 在单独一行上，flow-style 在同一行。
 */
function extractGroupType(line) {
  // block-style: `    type: XX`
  if (/^\s+type:\s*/.test(line) && !/\{/.test(line)) {
    return stripWrappedQuotes(line.replace(/^\s+type:\s*/, ""));
  }
  // flow-style: `  - { name: XX, type: YY, ... }`
  return extractFlowField(line, "type");
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

    // flow-style 行：name 和 type 都在同一行
    if (/^\s+-\s*\{.*name:/.test(line)) {
      const name = extractFlowField(line, "name");
      const type = extractFlowField(line, "type");
      if (name) {
        if (!byName && name.includes("自动选择")) {
          byName = name;
        }
        if (!byType && (type === "url-test" || type === "fallback" || type === "load-balance")) {
          byType = name;
        }
      }
      continue;
    }

    // block-style: `  - name: XX`
    if (/^\s+- name:\s*/.test(line)) {
      currentName = stripWrappedQuotes(line.replace(/^\s+- name:\s*/, ""));
      if (!byName && currentName.includes("自动选择")) {
        byName = currentName;
      }
      continue;
    }
    // block-style: `    type: XX`
    if (/^\s+type:\s*/.test(line)) {
      const type = stripWrappedQuotes(line.replace(/^\s+type:\s*/, ""));
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
    // flow-style
    if (/^\s+-\s*\{.*name:/.test(line)) {
      const name = extractFlowField(line, "name");
      if (name) {
        set.add(name);
      }
      continue;
    }
    // block-style
    if (/^\s+- name:\s*/.test(line)) {
      const name = stripWrappedQuotes(line.replace(/^\s+- name:\s*/, ""));
      if (name) {
        set.add(name);
      }
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

/**
 * 将新节点名称注入到 flow-style 行的 proxies: [...] 数组头部。
 * 例如: `{ name: X, proxies: [A, B] }` → `{ name: X, proxies: [New1, New2, A, B] }`
 */
function injectNamesIntoFlowProxies(line, names) {
  const idx = line.indexOf("proxies:");
  if (idx === -1) {
    return line;
  }
  const afterKey = line.indexOf("[", idx);
  if (afterKey === -1) {
    return line;
  }
  const prefix = names.map((n) => n).join(", ");
  // 插入到 [ 之后
  const beforeBracket = line.slice(0, afterKey + 1);
  const afterBracket = line.slice(afterKey + 1).trimStart();
  if (afterBracket.startsWith("]")) {
    // 空数组
    return `${beforeBracket}${prefix}${afterBracket}`;
  }
  return `${beforeBracket}${prefix}, ${afterBracket}`;
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
      // 检测 rules 块中下一行的缩进
      const nextIdx = lines.indexOf(line) + 1;
      let indent = "    ";
      for (let j = nextIdx; j < lines.length; j++) {
        const m = lines[j].match(/^(\s+)-/);
        if (m) { indent = m[1]; break; }
      }
      out.push(line);
      out.push(`${indent}- DST-PORT,22,DIRECT`);
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
      out.push(line);
      continue;
    } else if (inGroups && /^[^\s]/.test(line)) {
      inGroups = false;
    }

    if (inGroups) {
      const isFlowGroupItem = /^\s+-\s*\{.*name:/.test(line);
      const isBlockGroupItem = /^\s+- name:\s*/.test(line) && !isFlowGroupItem;

      if (isFlowGroupItem) {
        const name = extractFlowField(line, "name");
        const type = extractFlowField(line, "type");
        // 如果不是"自动选择"类分组，则注入新节点（仅按名称判断）
        if (name && !name.includes("自动选择")) {
          out.push(injectNamesIntoFlowProxies(line, allNewNames));
          continue;
        }
      } else if (isBlockGroupItem) {
        // 进入一个新的 block 分组
        const currentName = stripWrappedQuotes(line.replace(/^\s+- name:\s*/, ""));
        inFirstGroup = !currentName.includes("自动选择"); // 复用 inFirstGroup 变量表示当前组是否为目标组
        // 我们还需要看 type，但在这一行看不出。所以我们暂定只要名字不含自动选择就尝试进入。
        out.push(line);
        continue;
      }

      // block-style: 不再按 type 排除，仅在名称包含"自动选择"时排除（已在上面处理）

      // block-style: proxies: 行后注入
      if (inFirstGroup && /^\s+proxies:/.test(line)) {
        if (line.includes("[]")) {
          out.push(line.replace("[]", `[${allNewNames.join(", ")}]`));
        } else if (line.includes("[")) {
          // 已经有内容的 flow-style proxies 属性
          const idx = line.indexOf("[");
          out.push(line.slice(0, idx + 1) + allNewNames.join(", ") + ", " + line.slice(idx + 1));
        } else {
          // 纯 block-style 的 proxies: 标题
          out.push(line);
          for (const n of allNewNames) {
            out.push(`      - ${n}`);
          }
        }
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
    out.push("    - DST-PORT,22,DIRECT");
    insertedSshDirectRule = true;
  }

  if (!insertedProxyNodes || !insertedSshDirectRule) {
    fail("生成新 YAML 失败（可能未正确识别 proxies 或 rules 块）");
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

