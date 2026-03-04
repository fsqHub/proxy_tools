"use strict";

/**
 * v2ray 订阅链接 → Clash YAML 转换器
 *
 * 支持协议: vless://, vmess://, trojan://, ss://
 * 输入: base64 编码的多行链接文本（v2ray 订阅标准格式）
 * 输出: 可被 transformYaml 处理的 Clash YAML 字符串
 */

function safeDecodeURI(text) {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

// ─── vless:// ───────────────────────────────────────────
// vless://uuid@server:port?params#name
function parseVlessUri(uri) {
    const body = uri.slice("vless://".length);
    const hashIdx = body.indexOf("#");
    const name = hashIdx >= 0 ? safeDecodeURI(body.slice(hashIdx + 1)).trim() : "";
    const mainPart = hashIdx >= 0 ? body.slice(0, hashIdx) : body;

    const atIdx = mainPart.indexOf("@");
    if (atIdx < 0) return null;

    const uuid = mainPart.slice(0, atIdx);
    const rest = mainPart.slice(atIdx + 1);

    const qIdx = rest.indexOf("?");
    const hostPort = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
    const queryStr = qIdx >= 0 ? rest.slice(qIdx + 1) : "";

    const colonIdx = hostPort.lastIndexOf(":");
    if (colonIdx < 0) return null;
    const server = hostPort.slice(0, colonIdx);
    const port = Number(hostPort.slice(colonIdx + 1));
    if (!server || !Number.isFinite(port) || port <= 0) return null;

    const params = new URLSearchParams(queryStr);
    const security = params.get("security") || "";
    const sni = params.get("sni") || "";
    const fp = params.get("fp") || "";
    const pbk = params.get("pbk") || "";
    const sid = params.get("sid") || "";
    const flow = params.get("flow") || "";
    const alpn = params.get("alpn") || "";
    const net = params.get("type") || "tcp";
    const host = params.get("host") || "";
    const path = params.get("path") || "";

    const node = {
        name: name || `vless-${server}:${port}`,
        type: "vless",
        server,
        port,
        uuid,
        udp: true,
        "skip-cert-verify": false,
    };

    // TLS / Reality
    if (security === "reality") {
        node.tls = true;
        if (flow) node.flow = flow;
        if (fp) node["client-fingerprint"] = fp;
        if (sni) node.servername = sni;
        if (pbk || sid) {
            node["reality-opts"] = {};
            if (pbk) node["reality-opts"]["public-key"] = pbk;
            if (sid) node["reality-opts"]["short-id"] = sid;
        }
    } else if (security === "tls") {
        node.tls = true;
        if (flow) node.flow = flow;
        if (fp) node["client-fingerprint"] = fp;
        if (sni) node.servername = sni;
        if (alpn) node.alpn = alpn.split(",");
    } else {
        node.tls = false;
        if (flow) node.flow = flow;
    }

    // 传输层
    if (net === "ws") {
        node.network = "ws";
        const wsOpts = {};
        if (path) wsOpts.path = path;
        if (host) wsOpts.headers = { Host: host };
        if (Object.keys(wsOpts).length > 0) node["ws-opts"] = wsOpts;
    } else if (net === "grpc") {
        node.network = "grpc";
        const serviceName = params.get("serviceName") || "";
        if (serviceName) node["grpc-opts"] = { "grpc-service-name": serviceName };
    } else if (net === "h2") {
        node.network = "h2";
        const h2Opts = {};
        if (path) h2Opts.path = path;
        if (host) h2Opts.host = [host];
        if (Object.keys(h2Opts).length > 0) node["h2-opts"] = h2Opts;
    }

    return node;
}

// ─── vmess:// ───────────────────────────────────────────
// vmess://base64(JSON)
function parseVmessUri(uri) {
    const encoded = uri.slice("vmess://".length);
    let decoded;
    try {
        decoded = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
        return null;
    }
    const obj = safeJsonParse(decoded);
    if (!obj || !obj.add || !obj.port || !obj.id) return null;

    const node = {
        name: obj.ps || `vmess-${obj.add}:${obj.port}`,
        type: "vmess",
        server: obj.add,
        port: Number(obj.port),
        uuid: obj.id,
        alterId: Number(obj.aid || 0),
        cipher: obj.scy || "auto",
        udp: true,
        "skip-cert-verify": false,
    };

    const tls = (obj.tls || "").toLowerCase();
    if (tls === "tls") {
        node.tls = true;
        if (obj.sni) node.servername = obj.sni;
        if (obj.fp) node["client-fingerprint"] = obj.fp;
        if (obj.alpn) node.alpn = obj.alpn.split(",");
    }

    const net = obj.net || "tcp";
    if (net === "ws") {
        node.network = "ws";
        const wsOpts = {};
        if (obj.path) wsOpts.path = obj.path;
        if (obj.host) wsOpts.headers = { Host: obj.host };
        if (Object.keys(wsOpts).length > 0) node["ws-opts"] = wsOpts;
    } else if (net === "grpc") {
        node.network = "grpc";
        if (obj.path) node["grpc-opts"] = { "grpc-service-name": obj.path };
    } else if (net === "h2") {
        node.network = "h2";
        const h2Opts = {};
        if (obj.path) h2Opts.path = obj.path;
        if (obj.host) h2Opts.host = [obj.host];
        if (Object.keys(h2Opts).length > 0) node["h2-opts"] = h2Opts;
    }

    return node;
}

// ─── trojan:// ──────────────────────────────────────────
// trojan://password@server:port?params#name
function parseTrojanUri(uri) {
    const body = uri.slice("trojan://".length);
    const hashIdx = body.indexOf("#");
    const name = hashIdx >= 0 ? safeDecodeURI(body.slice(hashIdx + 1)).trim() : "";
    const mainPart = hashIdx >= 0 ? body.slice(0, hashIdx) : body;

    const atIdx = mainPart.indexOf("@");
    if (atIdx < 0) return null;
    const password = mainPart.slice(0, atIdx);
    const rest = mainPart.slice(atIdx + 1);

    const qIdx = rest.indexOf("?");
    const hostPort = qIdx >= 0 ? rest.slice(0, qIdx) : rest;
    const queryStr = qIdx >= 0 ? rest.slice(qIdx + 1) : "";

    const colonIdx = hostPort.lastIndexOf(":");
    if (colonIdx < 0) return null;
    const server = hostPort.slice(0, colonIdx);
    const port = Number(hostPort.slice(colonIdx + 1));
    if (!server || !Number.isFinite(port) || port <= 0) return null;

    const params = new URLSearchParams(queryStr);
    const sni = params.get("sni") || "";
    const alpn = params.get("alpn") || "";

    const node = {
        name: name || `trojan-${server}:${port}`,
        type: "trojan",
        server,
        port,
        password,
        udp: true,
        "skip-cert-verify": false,
    };

    if (sni) node.sni = sni;
    if (alpn) node.alpn = alpn.split(",");

    return node;
}

// ─── ss:// ──────────────────────────────────────────────
// ss://base64(method:password)@server:port#name
// ss://base64(method:password@server:port)#name
function parseSsUri(uri) {
    const body = uri.slice("ss://".length);
    const hashIdx = body.indexOf("#");
    const name = hashIdx >= 0 ? safeDecodeURI(body.slice(hashIdx + 1)).trim() : "";
    const mainPart = hashIdx >= 0 ? body.slice(0, hashIdx) : body;

    let method, password, server, port;
    const atIdx = mainPart.indexOf("@");

    if (atIdx >= 0) {
        // ss://base64(method:password)@server:port
        let userInfo;
        try {
            userInfo = Buffer.from(mainPart.slice(0, atIdx), "base64").toString("utf8");
        } catch {
            userInfo = mainPart.slice(0, atIdx);
        }
        const colonIdx = userInfo.indexOf(":");
        if (colonIdx < 0) return null;
        method = userInfo.slice(0, colonIdx);
        password = userInfo.slice(colonIdx + 1);

        const hostPort = mainPart.slice(atIdx + 1);
        const lastColon = hostPort.lastIndexOf(":");
        if (lastColon < 0) return null;
        server = hostPort.slice(0, lastColon);
        port = Number(hostPort.slice(lastColon + 1));
    } else {
        // ss://base64(method:password@server:port)
        let decoded;
        try {
            decoded = Buffer.from(mainPart, "base64").toString("utf8");
        } catch {
            return null;
        }
        const dAtIdx = decoded.indexOf("@");
        if (dAtIdx < 0) return null;
        const colonIdx = decoded.indexOf(":");
        if (colonIdx < 0 || colonIdx > dAtIdx) return null;
        method = decoded.slice(0, colonIdx);
        password = decoded.slice(colonIdx + 1, dAtIdx);
        const hostPort = decoded.slice(dAtIdx + 1);
        const lastColon = hostPort.lastIndexOf(":");
        if (lastColon < 0) return null;
        server = hostPort.slice(0, lastColon);
        port = Number(hostPort.slice(lastColon + 1));
    }

    if (!server || !Number.isFinite(port) || port <= 0) return null;

    return {
        name: name || `ss-${server}:${port}`,
        type: "ss",
        server,
        port,
        cipher: method,
        password,
        udp: true,
    };
}

// ─── 统一入口 ───────────────────────────────────────────

function parseSingleLink(line) {
    const trimmed = line.trim();
    if (trimmed.startsWith("vless://")) return parseVlessUri(trimmed);
    if (trimmed.startsWith("vmess://")) return parseVmessUri(trimmed);
    if (trimmed.startsWith("trojan://")) return parseTrojanUri(trimmed);
    if (trimmed.startsWith("ss://")) return parseSsUri(trimmed);
    return null;
}

/**
 * 检测文本是否为 v2ray 订阅格式（多行 URI 链接）
 */
function looksLikeV2rayLinks(text) {
    const lines = (text || "").split(/\r?\n/).filter((l) => l.trim());
    if (lines.length === 0) return false;
    const supportedPrefixes = ["vless://", "vmess://", "trojan://", "ss://"];
    const matchCount = lines.filter((l) =>
        supportedPrefixes.some((p) => l.trim().startsWith(p))
    ).length;
    // 至少有一半的行是代理链接
    return matchCount > 0 && matchCount >= lines.length * 0.5;
}

/**
 * 将节点对象的某个值转为 YAML 内联表示
 */
function yamlValue(val) {
    if (val === true) return "true";
    if (val === false) return "false";
    if (typeof val === "number") return String(val);
    if (typeof val === "string") {
        // 包含特殊字符时用单引号包裹
        if (/[:{}\[\],&#*?|>!%@`'"]/.test(val) || /^\s|\s$/.test(val)) {
            return `'${val.replace(/'/g, "''")}'`;
        }
        return val;
    }
    if (Array.isArray(val)) {
        return `[${val.map((v) => yamlValue(v)).join(", ")}]`;
    }
    if (typeof val === "object" && val !== null) {
        const pairs = Object.entries(val)
            .map(([k, v]) => `${k}: ${yamlValue(v)}`)
            .join(", ");
        return `{ ${pairs} }`;
    }
    return String(val);
}

/**
 * 将单个节点对象转为 Clash YAML 内联格式的一行
 */
function nodeToClashLine(node) {
    const parts = [];
    // 按 Clash 常见字段顺序输出
    const orderedKeys = [
        "name", "type", "server", "port", "uuid", "password",
        "alterId", "cipher", "udp", "tls", "skip-cert-verify",
        "flow", "client-fingerprint", "servername", "sni",
        "network", "alpn", "reality-opts", "ws-opts", "grpc-opts", "h2-opts",
    ];
    const seen = new Set();
    for (const key of orderedKeys) {
        if (Object.prototype.hasOwnProperty.call(node, key)) {
            parts.push(`${key}: ${yamlValue(node[key])}`);
            seen.add(key);
        }
    }
    // 追加剩余字段
    for (const [key, val] of Object.entries(node)) {
        if (!seen.has(key)) {
            parts.push(`${key}: ${yamlValue(val)}`);
        }
    }
    return `  - { ${parts.join(", ")} }`;
}

/**
 * 解析 v2ray 链接文本，返回节点对象数组和 Clash YAML 行
 * @param {string} linksText - 多行 v2ray 链接文本
 * @returns {{ nodes: object[], nodeNames: string[], proxyLines: string[] } | null}
 */
function parseV2rayLinks(linksText) {
    const lines = (linksText || "").split(/\r?\n/).filter((l) => l.trim());
    const nodes = [];
    const nameSet = new Set();

    for (const line of lines) {
        const node = parseSingleLink(line);
        if (!node) continue;

        let finalName = node.name;
        let suffix = 2;
        while (nameSet.has(finalName)) {
            finalName = `${node.name}-${suffix}`;
            suffix += 1;
        }
        node.name = finalName;
        nameSet.add(finalName);
        nodes.push(node);
    }

    if (nodes.length === 0) return null;

    return {
        nodes,
        nodeNames: nodes.map((n) => n.name),
        proxyLines: nodes.map((n) => nodeToClashLine(n)),
    };
}

/**
 * 将 v2ray 链接文本转换为 Clash YAML 字符串（无模板时生成最小化配置）
 */
function v2rayLinksToClashYaml(linksText) {
    const parsed = parseV2rayLinks(linksText);
    if (!parsed) return null;

    const yaml = [
        "mixed-port: 7890",
        "allow-lan: true",
        "mode: rule",
        "log-level: info",
        "proxies:",
        ...parsed.proxyLines,
        "proxy-groups:",
        "  - name: 自动选择",
        "    type: url-test",
        "    proxies:",
        ...parsed.nodeNames.map((n) => `      - ${n}`),
        "    url: 'http://www.gstatic.com/generate_204'",
        "    interval: 300",
        "rules:",
        "  - MATCH,自动选择",
        "",
    ];

    return yaml.join("\n");
}

// ─── 模板合并 ───────────────────────────────────────────

/**
 * 将 v2ray 订阅解析出的原生节点和代理组，完整提取并填入到模板中。
 *
 * 合并策略：
 *   - 从解析出的标准 Clash YAML 中结构化截取 `proxies:` 块和 `proxy-groups:` 块。
 *   - 扫描模板 YAML，在碰到 `proxies:` 和 `proxy-groups:` 时，将其替换为提取出的原生级块。
 *   - 模板里原有的其他内容（dns, rules 等）完全保留原样。
 *
 * 将 V2Ray 转换结果结构化地合并进模板。
 * 1. 提取 V2Ray 节点块插入到模板 proxies: 段。
 * 2. 将 V2Ray 节点名称注入到模板中所有代理组的 proxies: [] 列表中。
 */
function mergeV2rayNodesIntoTemplate(templateYaml, v2rayClashYaml) {
    const tLines = (templateYaml || "").replace(/\r\n/g, "\n").split("\n");
    const vLines = (v2rayClashYaml || "").replace(/\r\n/g, "\n").split("\n");

    const vProxiesBlock = [];
    const vNodeNames = [];
    let state = "";
    for (const line of vLines) {
        if (/^proxies:\s*$/.test(line)) {
            state = "proxies";
            continue;
        }
        if (/^proxy-groups:\s*$/.test(line)) {
            state = "groups";
            continue;
        }
        if (/^[a-zA-Z]/.test(line)) {
            state = "";
            continue;
        }

        if (state === "proxies" && /^\s+-/.test(line)) {
            vProxiesBlock.push(line);
            // 提取名称用于注入代理组
            const nameMatch = line.match(/name:\s*([^,}]+)/);
            if (nameMatch) {
                vNodeNames.push(nameMatch[1].trim());
            }
        }
    }

    const out = [];
    let inProxyGroups = false;
    const namesStr = vNodeNames.join(", ");

    for (let i = 0; i < tLines.length; i++) {
        const line = tLines[i];
        const trimmed = line.replace(/^\uFEFF/, "");

        if (/^proxies:\s*$/.test(trimmed)) {
            out.push(line);
            out.push(...vProxiesBlock);
            continue;
        }

        if (/^proxy-groups:\s*$/.test(trimmed)) {
            inProxyGroups = true;
            out.push(line);
            continue;
        }

        if (inProxyGroups) {
            // 如果遇到下一个顶层 key，说明 proxy-groups 结束了
            if (/^[a-zA-Z0-9_-]+:/.test(trimmed)) {
                inProxyGroups = false;
            } else if (vNodeNames.length > 0) {
                // 注入节点到该组的 proxies 列表中
                // flow-style: proxies: [...] — 追加到已有内容的末尾
                const proxiesMatch = line.match(/proxies:\s*\[(.*?)\]/);
                if (proxiesMatch) {
                    const existing = proxiesMatch[1].trim();
                    const newList = existing
                        ? `${existing}, ${namesStr}`
                        : namesStr;
                    out.push(line.replace(/proxies:\s*\[.*?\]/, `proxies: [${newList}]`));
                    continue;
                }
            }
        }

        out.push(line);
    }

    return out.join("\n");
}

module.exports = {
    looksLikeV2rayLinks,
    v2rayLinksToClashYaml,
    mergeV2rayNodesIntoTemplate,
};
