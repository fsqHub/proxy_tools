"use strict";

const fs = require("node:fs");

function createLogger(logFile) {
  function log(level, message) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${message}`;
    console.log(line);
    try {
      fs.appendFileSync(logFile, `${line}\n`, "utf8");
    } catch (error) {
      console.error(`[${ts}] [WARN] 写入日志文件失败: ${error.message || String(error)}`);
    }
  }

  return {
    info(message) {
      log("INFO", message);
    },
    warn(message) {
      log("WARN", message);
    },
    error(message) {
      log("ERROR", message);
    },
  };
}

module.exports = {
  createLogger,
};

