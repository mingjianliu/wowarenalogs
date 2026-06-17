#!/usr/bin/env node

const { exec } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/Users/mingjianliu';

// Read settings.json to get fallback active model
function getFallbackModel() {
  try {
    const p = path.join(HOME, '.gemini/antigravity-cli/settings.json');
    if (fs.existsSync(p)) {
      const settings = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (settings.model) {
        return settings.model;
      }
    }
  } catch {}
  return 'Gemini 3.5 Flash (High)';
}

// Read stdin JSON safely
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve(null);
      return;
    }
    let raw = '';
    
    const cleanup = () => {
      clearTimeout(timeout);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('error', onError);
      process.stdin.pause();
    };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 150);

    const onData = (chunk) => {
      raw += chunk;
    };

    const onEnd = () => {
      cleanup();
      try {
        resolve(JSON.parse(raw.trim()));
      } catch {
        resolve(null);
      }
    };

    const onError = () => {
      cleanup();
      resolve(null);
    };

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    process.stdin.on('error', onError);
  });
}

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 4 }, (err, stdout, stderr) => {
      err ? reject(new Error(stderr || err.message)) : resolve(stdout);
    });
  });
}

// Find language server port and CSRF token
async function detectServerInfo() {
  let psOut;
  try {
    psOut = await runCommand("ps aux");
  } catch {
    return null;
  }

  let pid = null;
  let csrfToken = null;

  for (const line of psOut.split("\n")) {
    const isLanguageServer = line.includes("language_server");
    const isAgy = line.match(/\bagy\b/);
    if (!isLanguageServer && !isAgy) continue;
    if (line.includes("grep ") || line.includes("npx ") || line.includes("agy-hud.js")) continue;

    const csrfMatch = line.match(/--csrf_token[=\s]+([A-Za-z0-9._/=+-]+)/);
    const parts = line.trim().split(/\s+/);
    const currentPid = parts[1];

    if (isLanguageServer) {
      if (!csrfMatch) continue;
      pid = currentPid;
      csrfToken = csrfMatch[1];
      break;
    } else if (isAgy) {
      pid = currentPid;
      csrfToken = csrfMatch ? csrfMatch[1] : "";
      break;
    }
  }

  if (!pid || csrfToken === null) return null;

  const ports = [];
  try {
    const isMac = process.platform === "darwin";
    if (isMac) {
      const out = await runCommand(`lsof -iTCP -sTCP:LISTEN -a -p ${pid} -n -P`);
      const portRegex = /(?:localhost|127\.0\.0\.1|::1|\*):(\d+)/gi;
      let m;
      while ((m = portRegex.exec(out)) !== null) {
        ports.push(parseInt(m[1], 10));
      }
    } else {
      const out = await runCommand(`ss -tlnp | grep "pid=${pid}"`);
      const portRegex = /127\.0\.0\.1:(\d+)/g;
      let m;
      while ((m = portRegex.exec(out)) !== null) {
        ports.push(parseInt(m[1], 10));
      }
    }
  } catch {}

  return { ports, csrfToken };
}

function callGetUserStatus(port, csrfToken) {
  return new Promise((resolve, reject) => {
    const body = "{}";
    const options = {
      hostname: "127.0.0.1",
      port,
      path: "/exa.language_server_pb.LanguageServerService/GetUserStatus",
      method: "POST",
      rejectUnauthorized: false,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-codeium-csrf-token": csrfToken,
      },
      timeout: 2000,
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on("error", err => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
    req.write(body);
    req.end();
  });
}

async function getModelQuotas() {
  try {
    const info = await detectServerInfo();
    if (!info || info.ports.length === 0) return null;

    let json = null;
    for (const port of info.ports) {
      try {
        json = await callGetUserStatus(port, info.csrfToken);
        if (json) break;
      } catch {}
    }
    if (!json) return null;

    const configs = json?.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? [];
    const subModels = [];
    const seen = new Set();

    for (const c of configs) {
      const label = c.label ?? c.name ?? "Unknown";
      if (seen.has(label)) continue;
      seen.add(label);

      const qi = c.quotaInfo ?? {};
      const remaining = "remainingFraction" in qi ? qi.remainingFraction : ("resetTime" in qi ? 0 : 1);
      const pct = Math.round((1 - remaining) * 100);

      subModels.push({
        name: label,
        used: pct,
        limit: 100,
        pct,
        resetsAt: qi.resetTime,
      });
    }
    return subModels;
  } catch {
    return null;
  }
}

function findQuota(subModels, modelName) {
  if (!subModels || !modelName) return null;
  const nameLower = modelName.toLowerCase();
  let match = subModels.find(m => m.name.toLowerCase() === nameLower);
  if (match) return match;
  match = subModels.find(m => m.name.toLowerCase().includes(nameLower) || nameLower.includes(m.name.toLowerCase()));
  return match || null;
}

function makeProgressBar(percent, colorCode, emptyColorCode = '\x1b[90m') {
  const width = 10;
  const filledCount = Math.round((percent / 100) * width);
  const emptyCount = width - filledCount;
  return `${colorCode}${'█'.repeat(filledCount)}${emptyColorCode}${'░'.repeat(emptyCount)}\x1b[0m`;
}

function formatReset(resetsAtStr) {
  if (!resetsAtStr) return '';
  const resetsAt = new Date(resetsAtStr);
  const diffMs = resetsAt.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `in ${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  const remainingMins = diffMins % 60;
  return `in ${diffHours}h ${remainingMins}m`;
}

async function main() {
  try {
    const [stdin, subModels] = await Promise.all([readStdin(), getModelQuotas()]);

    const fallbackModel = getFallbackModel();
    const activeModel = stdin?.model?.display_name || stdin?.model?.id || fallbackModel;

    // 1. Quota Info
    let quotaStr = 'Quota Left: \x1b[90mN/A\x1b[0m';
    let resetStr = '';
    if (subModels) {
      const quota = findQuota(subModels, activeModel);
      if (quota) {
        const remainingPct = 100 - quota.pct;
        let qColor = '\x1b[32m'; // Green
        if (remainingPct < 20) qColor = '\x1b[31m'; // Red
        else if (remainingPct < 50) qColor = '\x1b[33m'; // Yellow

        quotaStr = `Quota Left: ${makeProgressBar(remainingPct, qColor)} \x1b[1m${qColor}${remainingPct}%\x1b[0m`;
        if (quota.resetsAt) {
          resetStr = formatReset(quota.resetsAt);
        }
      } else {
        quotaStr = 'Quota Left: \x1b[32mUnlimited\x1b[0m';
      }
    }

    // 2. Context Info
    let contextPercent = 0;
    let hasContext = false;
    if (stdin && stdin.context_window) {
      hasContext = true;
      if (typeof stdin.context_window.used_percentage === 'number') {
        contextPercent = Math.round(stdin.context_window.used_percentage);
      } else {
        const size = stdin.context_window.context_window_size;
        const usage = stdin.context_window.current_usage;
        if (size && usage) {
          const input = usage.input_tokens ?? 0;
          const cacheRead = usage.cache_read_input_tokens ?? 0;
          const cacheWrite = usage.cache_creation_input_tokens ?? 0;
          const total = input + cacheRead + cacheWrite;
          contextPercent = Math.round((total / size) * 100);
        }
      }
    }

    let contextStr = 'Context: \x1b[90mN/A\x1b[0m';
    if (hasContext) {
      let ctxColor = '\x1b[32m'; // Green
      if (contextPercent > 85) ctxColor = '\x1b[31m'; // Red
      else if (contextPercent > 70) ctxColor = '\x1b[33m'; // Yellow
      contextStr = `Context: ${makeProgressBar(contextPercent, ctxColor)} \x1b[1m${ctxColor}${contextPercent}%\x1b[0m`;
    }

    // 3. Cost Info
    const cost = stdin?.cost?.total_cost_usd;
    const costVal = typeof cost === 'number' ? cost : 0;
    const costColor = costVal > 0 ? '\x1b[33m' : '\x1b[32m'; // Yellow if paid, Green if 0/free
    const costStr = `Session Cost: ${costColor}$${costVal.toFixed(4)}\x1b[0m`;

    // Render Layout
    console.log(`\x1b[1m\x1b[36m[${activeModel}]\x1b[0m \x1b[90m│\x1b[0m ${quotaStr} \x1b[90m│\x1b[0m ${contextStr}`);
    if (resetStr) {
      console.log(`${costStr} \x1b[90m│\x1b[0m Reset: \x1b[2m${resetStr}\x1b[0m`);
    } else {
      console.log(`${costStr}`);
    }
  } catch (err) {
    console.log(`\x1b[31m[agy-hud] Error: ${err.message}\x1b[0m`);
  } finally {
    process.exit(0);
  }
}

main();
