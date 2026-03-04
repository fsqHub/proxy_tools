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

  let templateYaml = "";
  if (sub.template && sub.template.toLowerCase() !== "none") {
    const fs = require("node:fs");
    const path = require("node:path");
    // registry.js 位于 bridge 目录下，所以跳到上层然后基于服务根目录解析
    const templatePath = path.resolve(__dirname, "..", sub.template);
    if (fs.existsSync(templatePath)) {
      templateYaml = fs.readFileSync(templatePath, "utf8");
    }
  }

  const source = await fetchTextWithTimeout(sub.aUrl, cfg.fetchTimeoutMs, headers, `预检拉取订阅 A(${sub.id}) 失败`);
  const extracted = extractClashYaml(source, templateYaml);
  if (!extracted) {
    const snippet = stripBom(source || "").replace(/\s+/g, " ").slice(0, 200);
    throw new Error(`预检解析失败: 无法识别为 Clash YAML，片段: ${snippet}`);
  }

  const transformed = transformYaml(extracted.yaml, proxyNodes);
  if (!transformed.addedNodeNames || transformed.addedNodeNames.length === 0) {
    throw new Error("预检改写失败: 没有成功加入任何链式代理节点");
  }

  // 保存生成的预热配置文件
  const fs = require("node:fs");
  const path = require("node:path");
  const outputPath = path.resolve(__dirname, "..", "output");
  if (!fs.existsSync(outputPath)) {
    fs.mkdirSync(outputPath, { recursive: true });
  }
  const savedFilePath = path.join(outputPath, `sub_${sub.id}.yaml`);
  fs.writeFileSync(savedFilePath, transformed.body, "utf8");

  return {
    parseMode: extracted.mode,
    addedNodeNames: transformed.addedNodeNames,
    skippedNodeNames: transformed.skippedNodeNames,
    dialerGroup: transformed.dialerGroup,
    savedTo: savedFilePath,
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
          `预检通过 id=${sub.id} token=${sub.token} mode=${check.parseMode} added=${check.addedNodeNames.join("|")} dialer=${check.dialerGroup} savedTo=${check.savedTo}`
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

