"use strict";

const { loadSubscriptionsCsv, loadProxyCsv } = require("./csv_loader");
const { fetchTextWithTimeout, extractClashYaml, stripBom } = require("./upstream_parser");
const { transformYaml } = require("./yaml_transform");

async function validateSubscriptionRow(sub, cfg, proxyNodes) {
  const headers = {
    "user-agent": "subscription-bridge/1.0",
    accept: "*/*",
  };
  if (cfg.upstreamAuthHeader) {
    headers.authorization = cfg.upstreamAuthHeader;
  }

  const source = await fetchTextWithTimeout(sub.aUrl, cfg.fetchTimeoutMs, headers, `预检拉取订阅 A(${sub.id}) 失败`);
  const extracted = extractClashYaml(source);
  if (!extracted) {
    const snippet = stripBom(source || "").replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`预检解析失败: 无法识别为 Clash YAML，片段: ${snippet}`);
  }

  const transformed = transformYaml(extracted.yaml, proxyNodes);
  if (!transformed.addedNodeNames || transformed.addedNodeNames.length === 0) {
    throw new Error("预检改写失败: 没有成功加入任何链式代理节点");
  }

  return {
    parseMode: extracted.mode,
    addedNodeNames: transformed.addedNodeNames,
    skippedNodeNames: transformed.skippedNodeNames,
    dialerGroup: transformed.dialerGroup,
  };
}

async function buildRegistry(cfg, logger) {
  const subscriptions = loadSubscriptionsCsv(cfg.subscriptionCsvFile).filter((x) => x.enabled);
  const proxyNodes = loadProxyCsv(cfg.proxyCsvFile);

  const activeSubs = [];
  const skippedSubs = [];

  for (const sub of subscriptions) {
    try {
      if (cfg.precheckOnStart) {
        const check = await validateSubscriptionRow(sub, cfg, proxyNodes);
        logger.info(
          `预检通过 id=${sub.id} token=${sub.token} mode=${check.parseMode} added=${check.addedNodeNames.join("|")} dialer=${check.dialerGroup}`
        );
      } else {
        logger.info(`跳过预检 id=${sub.id} token=${sub.token}`);
      }
      activeSubs.push(sub);
    } catch (error) {
      skippedSubs.push({
        ...sub,
        reason: error.message || String(error),
      });
      logger.warn(`跳过订阅 id=${sub.id} token=${sub.token} 原因: ${error.message || String(error)}`);
    }
  }

  const tokenMap = new Map();
  for (const sub of activeSubs) {
    tokenMap.set(sub.token, sub);
  }

  return {
    proxyNodes,
    activeSubs,
    skippedSubs,
    tokenMap,
  };
}

module.exports = {
  buildRegistry,
};

