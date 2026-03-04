"use strict";

const { looksLikeV2rayLinks, v2rayLinksToClashYaml, mergeV2rayNodesIntoTemplate } = require("./v2ray_converter");

function fail(message) {
  throw new Error(message);
}

function stripBom(text) {
  if (!text) {
    return text;
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isTopLevelKeyLine(line, key) {
  const withoutBom = line.replace(/^\uFEFF/, "");
  if (/^\s/.test(withoutBom)) {
    return false;
  }
  return new RegExp(`^${key}:\\s*$`).test(withoutBom);
}

function looksLikeClashYamlText(text) {
  const normalized = stripBom(text || "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const hasProxies = lines.some((line) => isTopLevelKeyLine(line, "proxies"));
  const hasProxyGroups = lines.some((line) => isTopLevelKeyLine(line, "proxy-groups"));
  return hasProxies && hasProxyGroups;
}

function safeDecodeURIComponent(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function tryDecodeBase64(text) {
  const compact = (text || "").trim().replace(/\s+/g, "");
  if (compact.length < 32) {
    return "";
  }
  if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) {
    return "";
  }
  const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    if (!decoded || /[\x00-\x08\x0E-\x1F]/.test(decoded)) {
      return "";
    }
    return decoded;
  } catch {
    return "";
  }
}

function findClashYamlInJsonValue(value, depth = 0) {
  if (depth > 8 || value == null) {
    return "";
  }

  if (typeof value === "string") {
    const candidates = [value, safeDecodeURIComponent(value), tryDecodeBase64(value)];
    for (const c of candidates) {
      if (c && looksLikeClashYamlText(c)) {
        return stripBom(c);
      }
    }
    for (const c of candidates) {
      if (!c) {
        continue;
      }
      const t = c.trim();
      if (!(t.startsWith("{") || t.startsWith("["))) {
        continue;
      }
      try {
        const nested = JSON.parse(t);
        const nestedYaml = findClashYamlInJsonValue(nested, depth + 1);
        if (nestedYaml) {
          return nestedYaml;
        }
      } catch {
        // ignore invalid nested json
      }
    }
    return "";
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const yaml = findClashYamlInJsonValue(item, depth + 1);
      if (yaml) {
        return yaml;
      }
    }
    return "";
  }

  if (typeof value === "object") {
    const preferredKeys = ["clash", "yaml", "config", "content", "data", "result", "payload", "body"];
    for (const k of preferredKeys) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        const yaml = findClashYamlInJsonValue(value[k], depth + 1);
        if (yaml) {
          return yaml;
        }
      }
    }
    for (const k of Object.keys(value)) {
      if (preferredKeys.includes(k)) {
        continue;
      }
      const yaml = findClashYamlInJsonValue(value[k], depth + 1);
      if (yaml) {
        return yaml;
      }
    }
  }

  return "";
}

function extractClashYaml(rawText, templateYaml) {
  const raw = stripBom(rawText || "");
  if (looksLikeClashYamlText(raw)) {
    return { yaml: raw, mode: "direct_yaml" };
  }

  const decodedUrl = safeDecodeURIComponent(raw);
  if (decodedUrl !== raw && looksLikeClashYamlText(decodedUrl)) {
    return { yaml: stripBom(decodedUrl), mode: "url_decoded_yaml" };
  }

  const decodedB64 = tryDecodeBase64(raw);
  if (decodedB64 && looksLikeClashYamlText(decodedB64)) {
    return { yaml: stripBom(decodedB64), mode: "base64_yaml" };
  }

  const jsonCandidates = [raw, decodedUrl, decodedB64].filter(Boolean);
  for (const candidate of jsonCandidates) {
    const t = candidate.trim();
    if (!(t.startsWith("{") || t.startsWith("["))) {
      continue;
    }
    try {
      const parsed = JSON.parse(t);
      const yaml = findClashYamlInJsonValue(parsed);
      if (yaml) {
        return { yaml, mode: "json_wrapped_yaml" };
      }
    } catch {
      // ignore invalid json
    }
  }

  // 尝试 v2ray 订阅格式（base64 编码的 vless/vmess/trojan/ss 链接）
  const v2rayCandidates = [raw, decodedUrl, decodedB64].filter(Boolean);
  for (const candidate of v2rayCandidates) {
    if (looksLikeV2rayLinks(candidate)) {
      // 如果提供了模板，提取 v2ray 转化出的 proxies 和 proxy-groups 整体结构注入到模板中
      if (templateYaml) {
        const v2rayYaml = v2rayLinksToClashYaml(candidate);
        if (v2rayYaml) {
          const merged = mergeV2rayNodesIntoTemplate(templateYaml, v2rayYaml);
          if (merged) {
            return { yaml: merged, mode: "v2ray_template_merged" };
          }
        }
      }
      // 无模板时生成最小化 Clash YAML
      const yaml = v2rayLinksToClashYaml(candidate);
      if (yaml) {
        return { yaml, mode: "v2ray_converted" };
      }
    }
  }

  return null;
}

async function fetchTextWithTimeout(url, timeoutMs, headers = {}, errorPrefix = "请求失败") {
  const nodeHttp = require("node:http");
  const nodeHttps = require("node:https");
  const { URL: NodeURL } = require("node:url");

  return new Promise((resolve, reject) => {
    const parsed = new NodeURL(url);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? nodeHttps : nodeHttp;

    const options = {
      method: "GET",
      headers,
      timeout: timeoutMs,
    };
    // 跳过 TLS 证书验证，以支持自签名证书的 HTTPS URL
    if (isHttps) {
      options.rejectUnauthorized = false;
    }

    const req = transport.request(url, options, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        req.destroy();
        reject(new Error(`${errorPrefix}，HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.setEncoding("utf8");
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(chunks.join("")));
      res.on("error", (err) => reject(err));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`${errorPrefix}，超时(${timeoutMs}ms)`));
    });

    req.on("error", (err) => {
      reject(err);
    });

    req.end();
  });
}

module.exports = {
  stripBom,
  isTopLevelKeyLine,
  extractClashYaml,
  fetchTextWithTimeout,
};

