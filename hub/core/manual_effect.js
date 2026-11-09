/* ============================================================
 * manual_effect.js —— Hub“手动调参”的 AE 调度与参数解析
 *
 * 每次操作启动一个独立 After Effects 实例，运行
 * tools/manual_probe.jsx；结果落在 %TEMP%/DreamEngineManual/job-*：
 *   p0_dump.tsv      参数树（dump）
 *   data/thumbs/…    一帧 PNG（baseline / verify）
 *   manual_result.json
 *
 * 这里只做进程调度、结果读取和 TSV 解析，不碰 UI，也不写用户覆盖表
 *（覆盖表由 main.js 调 core/effect_overrides.js 写）。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFileSync } = require("node:child_process");

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

function safeName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "effect";
}

/** 参数树 TSV → 行数组；表头按列名读取，坏行跳过。 */
function parseDump(text) {
  const lines = String(text || "").split(/\r?\n/);
  if (!lines.length) return [];
  const header = lines[0].split("\t").map((cell) => cell.trim());
  const at = (cells, name) => {
    const index = header.indexOf(name);
    return index >= 0 ? String(cells[index] === undefined ? "" : cells[index]) : "";
  };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cells = line.split("\t");
    const indexPath = at(cells, "indexPath");
    if (!indexPath) continue;
    const type = at(cells, "type") || "unknown";
    const rawValue = at(cells, "value");
    let value = rawValue;
    let valueType = "text";
    if (type === "OneD") {
      const number = Number(rawValue);
      if (Number.isFinite(number)) {
        value = number;
        valueType = "number";
      }
    } else if (type === "Checkbox") {
      value = /^(true|1)$/i.test(rawValue);
      valueType = "boolean";
    } else if (rawValue.startsWith("[")) {
      try {
        value = JSON.parse(rawValue);
        valueType = "array";
      } catch {
        value = rawValue;
      }
    }
    const pathNames = at(cells, "path");
    const parts = pathNames ? pathNames.split(" / ") : [];
    rows.push({
      indexPath,
      path: pathNames,
      name: at(cells, "name") || (parts.length ? parts[parts.length - 1] : ""),
      type,
      value,
      valueText: rawValue,
      valueType,
      canAnimate: /^(1|true)$/i.test(at(cells, "canAnimate")),
      hasMin: /^(1|true)$/i.test(at(cells, "hasMin")),
      min: Number(at(cells, "min")) || 0,
      hasMax: /^(1|true)$/i.test(at(cells, "hasMax")),
      max: Number(at(cells, "max")) || 0,
      aux: /^(1|true)$/i.test(at(cells, "aux")),
      safe: /^(1|true)$/i.test(at(cells, "safe")),
      reason: at(cells, "reason"),
    });
  }
  return rows;
}

class ManualEffectRunner {
  constructor(opts) {
    this.paths = opts.paths;
    this.script = opts.script;
    this.jsx = opts.jsx;
    this.template = opts.template;
    this.powershell = opts.powershell || "powershell.exe";
    this.timeoutMs = Number(opts.timeoutMs) || 300000;
    this.proc = null;
  }

  isRunning() {
    return !!this.proc;
  }

  stop() {
    if (!this.proc) return { ok: false, reason: "not_running" };
    const pid = this.proc.pid;
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        timeout: 8000,
      });
    } catch {
      try { this.proc.kill(); } catch { /* already exited */ }
    }
    return { ok: true, pid };
  }

  run(opts = {}) {
    if (this.proc) return Promise.resolve({ ok: false, reason: "already_running" });
    const matchName = String(opts.matchName || "").trim();
    const mode = String(opts.mode || "dump");
    if (!matchName) return Promise.resolve({ ok: false, reason: "missing_match_name" });
    if (!["dump", "fastdump", "baseline", "verify"].includes(mode)) {
      return Promise.resolve({ ok: false, reason: "bad_mode" });
    }
    if (!this.script || !fs.existsSync(this.script)) {
      return Promise.resolve({ ok: false, reason: "no_script", detail: this.script });
    }
    if (!this.jsx || !fs.existsSync(this.jsx)) {
      return Promise.resolve({ ok: false, reason: "no_probe", detail: this.jsx });
    }
    if (!this.template || !fs.existsSync(this.template)) {
      return Promise.resolve({ ok: false, reason: "no_template", detail: this.template });
    }
    if (!opts.ae || !fs.existsSync(opts.ae)) {
      return Promise.resolve({ ok: false, reason: "no_ae", detail: opts.ae || "" });
    }

    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const outDir = path.join(os.tmpdir(), "DreamEngineManual",
      ["job", safeName(matchName), mode, stamp].join("-"));
    try {
      fs.mkdirSync(outDir, { recursive: true });
    } catch (error) {
      return Promise.resolve({ ok: false, reason: "mkdir_failed", detail: String(error.message || error) });
    }

    const args = [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.script,
      "-Ae", String(opts.ae),
      "-Extension", this.paths.extDir,
      "-Target", matchName,
      "-Mode", mode,
      "-OutDir", outDir,
      "-Template", this.template,
      "-Probe", this.jsx,
      "-TimeoutSec", String(Math.max(30, Math.round(this.timeoutMs / 1000))),
    ];
    let stdout = "";
    let stderr = "";
    let settled = false;
    return new Promise((resolve) => {
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.proc = null;
        resolve(value);
      };
      let proc;
      try {
        proc = spawn(this.powershell, args, {
          cwd: path.dirname(this.script),
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({ ok: false, reason: "spawn_failed", detail: String(error.message || error) });
        return;
      }
      this.proc = proc;
      if (proc.stdout) proc.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
      if (proc.stderr) proc.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      const timer = setTimeout(() => {
        try {
          execFileSync("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
            windowsHide: true,
            timeout: 8000,
          });
        } catch {
          try { proc.kill(); } catch { /* ignore */ }
        }
        const result = readJson(path.join(outDir, "manual_result.json"));
        finish({
          ok: false,
          reason: "timeout",
          outDir,
          result,
          stdout: stdout.slice(-4000),
          stderr: stderr.slice(-4000),
        });
      }, this.timeoutMs);
      proc.on("error", (error) => {
        finish({ ok: false, reason: "spawn_failed", detail: String(error.message || error), outDir });
      });
      proc.on("exit", (code) => {
        const result = readJson(path.join(outDir, "manual_result.json"));
        const dumpPath = path.join(outDir, "p0_dump.tsv");
        const params = fs.existsSync(dumpPath) ? parseDump(readText(dumpPath)) : [];
        const png = (result && result.png) || "";
        finish({
          ok: !!(result && result.ok),
          status: (result && result.status) || (code === 0 ? "unknown" : "exit_" + code),
          phase: (result && result.phase) || "",
          message: (result && result.message) || "",
          outDir,
          params,
          png,
          result,
          stdout: stdout.slice(-4000),
          stderr: stderr.slice(-4000),
        });
      });
    });
  }
}

module.exports = { ManualEffectRunner, parseDump, safeName };
