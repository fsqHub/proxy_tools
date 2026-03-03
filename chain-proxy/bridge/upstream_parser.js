"use strict";

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

function extractClashYaml(rawText) {
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

  return null;
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
  } catch (error) {
    if (error && error.name === "AbortError") {
      fail(`${errorPrefix}，超时(${timeoutMs}ms)`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  stripBom,
  isTopLevelKeyLine,
  extractClashYaml,
  fetchTextWithTimeout,
};

