"use strict";

const { fetchTextWithTimeout } = require("./upstream_parser");

function fail(message) {
  throw new Error(message);
}

function buildTokenHint(token) {
  return token ? `?token=${encodeURIComponent(token)}` : "";
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
      // try next provider
    }
  }
  return "";
}

async function resolveSubscriptionLink(cfg, token, options = {}) {
  const tokenHint = buildTokenHint(token);
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
      fail("无法自动探测公网IP，请设置 PUBLIC_BASE_URL（例如 http://你的公网IP:端口）");
    }
    hostForLink = publicIp;
  }

  return `http://${hostForLink}:${cfg.port}${normalizedPath}${tokenHint}`;
}

module.exports = {
  resolveSubscriptionLink,
};

