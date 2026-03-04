"use strict";

const os = require("node:os");

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

function isPrivateIpv4(ip) {
  const parts = ip.split(".").map((x) => Number(x));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  if (parts[0] === 10) {
    return true;
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  if (parts[0] === 192 && parts[1] === 168) {
    return true;
  }
  return false;
}

function isIpv4Family(family) {
  return family === "IPv4" || family === 4;
}

function isVirtualOrTunnelInterface(ifName) {
  return /^(lo|docker\d*|veth|br-|cni|flannel|kube|tun\d*|tap\d*|utun\d*|wg\d*|tailscale\d*|zt[a-z0-9]*|ppp\d*|virbr\d*|vmnet\d*)/i.test(
    ifName || ""
  );
}

function isPreferredLanInterface(ifName) {
  return /^(eth|en|wl|wlan|bond)/i.test(ifName || "");
}

function detectLanIpv4() {
  const nets = os.networkInterfaces();
  const preferred = [];
  const fallback = [];

  for (const [ifName, items] of Object.entries(nets)) {
    if (!Array.isArray(items)) {
      continue;
    }
    if (isVirtualOrTunnelInterface(ifName)) {
      continue;
    }

    for (const item of items) {
      if (!item || item.internal || !isIpv4Family(item.family)) {
        continue;
      }
      const ip = extractIpv4(item.address || "");
      if (!ip) {
        continue;
      }
      if (!isPrivateIpv4(ip)) {
        continue;
      }

      if (isPreferredLanInterface(ifName)) {
        preferred.push(ip);
      } else {
        fallback.push(ip);
      }
    }
  }

  return preferred[0] || fallback[0] || "";
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
  const detail = await resolveSubscriptionLinkDetail(cfg, token, options);
  return detail.link;
}

async function resolveSubscriptionLinkDetail(cfg, token, options = {}) {
  const tokenHint = buildTokenHint(token);
  const normalizedPath = normalizePath(cfg.bPath);

  if (cfg.publicBaseUrl) {
    const base = cfg.publicBaseUrl.replace(/\/+$/, "");
    return {
      link: `${base}${normalizedPath}${tokenHint}`,
      source: "public_base_url",
      host: "",
    };
  }

  let hostForLink = cfg.host;
  let source = "listen_host";
  if (isWildcardListenHost(cfg.host)) {
    const publicIp = await detectPublicIp(cfg.publicIpDetectTimeoutMs);
    if (publicIp) {
      hostForLink = publicIp;
      source = "public_ip";
    } else {
      const lanIp = detectLanIpv4();
      if (lanIp) {
        hostForLink = lanIp;
        source = "lan_ip";
      } else if (options.allowPlaceholder) {
        return {
          link: "(无法自动探测公网/局域网IP，请设置 PUBLIC_BASE_URL)",
          source: "placeholder",
          host: "",
        };
      } else {
        fail("无法自动探测公网/局域网IP，请设置 PUBLIC_BASE_URL（例如 http://你的公网IP:端口）");
      }
    }
  }

  return {
    link: `http://${hostForLink}:${cfg.port}${normalizedPath}${tokenHint}`,
    source,
    host: hostForLink,
  };
}

module.exports = {
  resolveSubscriptionLink,
  resolveSubscriptionLinkDetail,
};
