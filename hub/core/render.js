/* ============================================================
 * render.js —— 渲染调度（只做调度，不重写渲染逻辑）
 *
 * 硬约束：插件渲染的调度逻辑**只有一份实现**，就是
 * tools/generate_plugin_presets.ps1。它是实机跑过 34 轮 / 773 条、
 * 带崩溃黑名单与断点续做的版本。Hub 如果自己再写一遍 Node 版，
 * 两套必然漂移 —— 这和「曲线数学只写一份」是同一条教训。
 *
 * Hub 的职责只有三件：
 *   1. spawn 那个 ps1（零 Node 依赖，别人机器上也不用装 Node）
 *   2. 轮询 hub_state.json 显示进度（不解析控制台，避开 GBK 编码坑）
 *   3. 停止时 taskkill /T，把 ps1 连带它拉起的 AE 实例一起收掉
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

function readStateFile(statePath) {
  let raw;
  try {
    raw = fs.readFileSync(statePath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    // 脚本正在写，读到半截 JSON 是正常的，下一轮再读
    return null;
  }
}

function normalizeFps(value) {
  const fps = Number(value);
  return [12, 24, 30, 60].includes(fps) ? fps : 24;
}

class RenderJob {
  /**
   * @param {object} opts
   * @param {ReturnType<import("./paths").createPaths>} opts.paths
   * @param {string} opts.script       generate_plugin_presets.ps1 绝对路径
   * @param {(state: object) => void} [opts.onState]
   * @param {(info: object) => void} [opts.onExit]
   * @param {string} [opts.powershell]
   */
  constructor(opts) {
    this.paths = opts.paths;
    this.script = opts.script;
    this.powershell = opts.powershell || "powershell.exe";
    this.onState = opts.onState || (() => {});
    this.onExit = opts.onExit || (() => {});
    this.proc = null;
    this.timer = null;
    this.running = false;
    this.lastState = null;
  }

  isRunning() {
    return this.running;
  }

  /**
   * @param {{ae?: string, background?: string, limit?: number, autoClose?: boolean, rounds?: number, onlyPreset?: string}} [options]
   */
  start(options = {}) {
    if (this.running) return { ok: false, reason: "already_running" };
    if (!this.script || !fs.existsSync(this.script)) {
      return { ok: false, reason: "no_script", detail: this.script };
    }

    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.script];
    if (options.ae) args.push("-AE", String(options.ae));
    if (options.background) args.push("-Background", String(options.background));
    if (options.fps !== undefined) args.push("-Fps", String(normalizeFps(options.fps)));
    if (options.limit) args.push("-Limit", String(Number(options.limit) || 40));
    if (options.rounds) args.push("-Rounds", String(Number(options.rounds) || 40));
    if (options.autoClose) args.push("-AutoClose");
    if (options.retryFailed) args.push("-RetryFailed");
    if (options.onlyPreset) args.push("-OnlyPreset", String(options.onlyPreset));
    if (options.presetList) args.push("-PresetList", String(options.presetList));
    if (options.force) args.push("-Force");

    try {
      this.proc = spawn(this.powershell, args, {
        cwd: path.dirname(this.script),
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
    } catch (error) {
      return { ok: false, reason: "spawn_failed", detail: String(error.message || error) };
    }

    this.running = true;
    this.lastState = null;

    this.proc.on("exit", (code, signal) => {
      this.running = false;
      this.stopPolling();
      const finalState = readStateFile(this.paths.hubState) || this.lastState;
      this.lastState = finalState;
      if (finalState) this.onState(finalState);
      this.onExit({ code, signal, state: finalState });
    });

    this.startPolling();
    return { ok: true, pid: this.proc.pid };
  }

  startPolling() {
    this.stopPolling();
    this.timer = setInterval(() => {
      const state = readStateFile(this.paths.hubState);
      if (!state) return;
      this.lastState = state;
      this.onState(state);
    }, 500);
  }

  stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 停止：/T 连带子进程（那个专用 AE 实例）一起收掉 */
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
        /* 已经退了 */
      }
    }
    return { ok: true, pid };
  }

  /** 一次性读完当前状态，用于窗口刚打开时回显上一轮的结果 */
  snapshot() {
    return readStateFile(this.paths.hubState);
  }
}

module.exports = { RenderJob, readStateFile };
