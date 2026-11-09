/* Plugin effect parameter dump scheduler.
 *
 * 参数树的读取（启动 AE、加效果、collectLeaves、写 TSV）全部在
 * tools/dump_plugin_effect_params.ps1 + tools/manual_probe.jsx 里完成。
 * Hub 这里只做三件事：写目标清单、spawn 脚本、轮询状态文件。
 *
 * 契约（与脚本、与 renderer 的 3a 获取页对齐）：
 *   输入  <probe>/next_effect_dump.tsv     每行一个 matchName（可再跟 plugin / category）
 *   状态  <probe>/effect_dump_state.json   {phase,message,round,total,current,currentName,ok,fail,outputDir,updatedAt}
 *   原始  <probe>/effect_params_raw/<stamp>/<safe>/p0_dump.tsv
 *   日志  <probe>/effect_dump.log
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

function readStateFile(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

class EffectDumpJob {
  constructor(opts) {
    this.paths = opts.paths;
    this.script = opts.script;
    this.rawDir = opts.rawDir || opts.paths.effectParamsRaw;
    this.powershell = opts.powershell || "powershell.exe";
    this.onState = opts.onState || (() => {});
    // 每完成一批就把原始 dump 合并进分组缓存（合并逻辑在 effect_param_cache）
    this.onRound = opts.onRound || (() => {});
    this.onExit = opts.onExit || (() => {});
    this.proc = null;
    this.timer = null;
    this.running = false;
    this.lastState = null;
    this.lastRound = -1;
    this.startedAt = 0;
  }

  isRunning() {
    return this.running;
  }

  /** 写目标清单。返回写入条数；targets 形如 ["matchName"] 或 [{matchName,plugin,category}] */
  writeTargets(targets) {
    const list = Array.isArray(targets) ? targets : [];
    const lines = [];
    for (const item of list) {
      const record = typeof item === "string" ? { matchName: item } : item || {};
      const matchName = String(record.matchName || "").trim();
      if (!matchName) continue;
      const cells = [matchName, String(record.plugin || ""), String(record.category || "")];
      lines.push(cells.join("\t"));
    }
    const file = path.join(this.paths.probe, "next_effect_dump.tsv");
    fs.mkdirSync(this.paths.probe, { recursive: true });
    fs.writeFileSync(file, lines.join("\r\n") + (lines.length ? "\r\n" : ""), "utf8");
    return { ok: true, file, count: lines.length };
  }

  start(options = {}) {
    if (this.running) return { ok: false, reason: "already_running" };
    if (!this.script || !fs.existsSync(this.script)) {
      return { ok: false, reason: "no_script", detail: this.script };
    }

    const targetsFile = path.join(this.paths.probe, "next_effect_dump.tsv");
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      this.script,
      "-Probe",
      this.paths.probe,
      "-Extension",
      this.paths.extDir,
      "-Targets",
      targetsFile,
      "-RawDir",
      this.rawDir,
      "-Limit",
      String(Number(options.limit) || 20),
      "-Rounds",
      String(Number(options.rounds) || 50),
    ];
    // 空值一律不传：Windows 命令行会把 "" 吞掉，让下一个 -参数 变成上一个参数的值
    if (options.ae) args.push("-Ae", String(options.ae));
    if (options.force) args.push("-Force");

    try {
      fs.rmSync(this.paths.effectDumpState, { force: true });
    } catch {
      /* stale state is harmless */
    }

    const logPath = this.paths.effectDumpLog || path.join(this.paths.probe, "effect_dump.log");
    const appendLog = (chunk) => {
      try {
        fs.appendFileSync(logPath, chunk, "utf8");
      } catch {
        /* diagnostics log is best effort */
      }
    };
    try {
      fs.writeFileSync(logPath, "[spawn] " + this.powershell + " " + args.join(" ") + "\r\n", "utf8");
    } catch {
      /* ignore */
    }

    try {
      this.proc = spawn(this.powershell, args, {
        cwd: path.dirname(this.script),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return { ok: false, reason: "spawn_failed", detail: String(error.message || error) };
    }
    if (this.proc.stdout) {
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", appendLog);
    }
    if (this.proc.stderr) {
      this.proc.stderr.setEncoding("utf8");
      this.proc.stderr.on("data", appendLog);
    }
    this.proc.on("error", (error) => {
      appendLog("\r\n[spawn error] " + String(error.message || error) + "\r\n");
    });

    this.running = true;
    this.lastState = null;
    this.lastRound = -1;
    this.startedAt = Date.now();

    this.proc.on("exit", (code, signal) => {
      this.running = false;
      this.stopPolling();
      const finalState = readStateFile(this.paths.effectDumpState) || this.lastState;
      this.lastState = finalState;
      if (finalState) {
        this.flushRound(finalState);
        this.onState(finalState);
      }
      this.onExit({ code, signal, state: finalState });
    });

    this.startPolling();
    return { ok: true, pid: this.proc.pid };
  }

  /** 轮次推进时，把原始 dump 交给上层合并（同一轮只合并一次） */
  flushRound(state) {
    if (!state) return;
    const key = String(state.outputDir || "") + "#" + String(Number(state.round) || 0);
    if (key === this.lastMergeKey) return;
    this.lastMergeKey = key;
    try {
      this.onRound(state);
    } catch {
      /* merge failures must not kill the polling loop */
    }
  }

  startPolling() {
    this.stopPolling();
    this.timer = setInterval(() => {
      const state = readStateFile(this.paths.effectDumpState);
      if (!state) return;
      this.lastState = state;
      this.flushRound(state);
      this.onState(state);
    }, 500);
  }

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  stop() {
    if (!this.proc || !this.running) return { ok: false, reason: "not_running" };
    const pid = this.proc.pid;
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        timeout: 8000,
      });
    } catch {
      try {
        this.proc.kill();
      } catch {
        /* already exited */
      }
    }
    try {
      const state = {
        ...(this.lastState || {}),
        phase: "cancelled",
        message: "已手动停止，已获取的属性会保留",
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.paths.effectDumpState, JSON.stringify(state), "utf8");
      this.lastState = state;
    } catch {
      /* state write is best effort */
    }
    return { ok: true, pid };
  }

  snapshot() {
    return readStateFile(this.paths.effectDumpState);
  }
}

module.exports = { EffectDumpJob, readStateFile };
