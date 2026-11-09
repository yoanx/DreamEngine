/* ============================================================
 * ae_guard.js —— AE 崩溃修复对话框看守（常驻子进程）
 *
 * AE 上次异常退出后，下次启动有概率弹「崩溃修复选项」对话框，把脚本化启动卡死。
 * 真正的检测与按键逻辑在 tools/ae_crash_guard.ps1（Win32 枚举 + PostMessage Enter），
 * 这里只做三件事：spawn / 停 / 读日志，和 RenderJob、PluginEffectJob 保持同一种风格。
 *
 * 生命周期由 main.js 决定：开始渲染 / 取参 / 扫描目录时 start，任务结束或退出时 stop。
 * ============================================================ */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

class AeGuardJob {
  /**
   * @param {{paths:object, script:string, powershell?:string, logPath?:string}} opts
   */
  constructor(opts = {}) {
    this.paths = opts.paths;
    this.script = opts.script;
    this.powershell = opts.powershell || "powershell.exe";
    this.logPath = opts.logPath || (this.paths && this.paths.aeGuardLog) || "";
    this.child = null;
    this.pid = 0;
    this.startedAt = "";
    this.options = null;
  }

  isRunning() {
    return !!(this.child && this.child.exitCode === null && !this.child.killed);
  }

  /** 兜底日志：ps1 自己会写 -LogPath，这里只接 Add-Type / 启动失败的 stderr */
  appendLog(text) {
    if (!this.logPath || !text) return;
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      fs.appendFileSync(this.logPath, String(text), "utf8");
    } catch {
      /* 日志写不进去也不该影响渲染 */
    }
  }

  /** 本地时间戳，与 ps1 里的 [yyyy-MM-ddTHH:mm:ss] 对齐（两边同一个日志文件） */
  stamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      "T" +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes()) +
      ":" +
      pad(d.getSeconds())
    );
  }

  /**
   * @param {{timeoutSec?:number, intervalSec?:number, dryRun?:boolean, quiet?:boolean}} [options]
   */
  start(options = {}) {
    if (this.isRunning()) return { ok: true, alreadyRunning: true, pid: this.pid };
    if (!this.script || !fs.existsSync(this.script)) {
      return { ok: false, reason: "missing_script" };
    }
    const timeoutSec = clampInt(options.timeoutSec, 10, 24 * 3600, 7200);
    const intervalMs = clampInt((options.intervalSec || 1.2) * 1000, 300, 10000, 1200);
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.script];
    if (this.logPath) args.push("-LogPath", this.logPath);
    args.push("-TimeoutSec", String(timeoutSec));
    args.push("-IntervalMs", String(intervalMs));
    args.push("-Singleton", "-Quiet");
    if (options.dryRun) args.push("-DryRun");

    try {
      fs.mkdirSync(path.dirname(this.script), { recursive: true });
    } catch {
      /* 目录已存在 */
    }

    this.options = { timeoutSec, intervalMs, dryRun: !!options.dryRun };
    this.startedAt = new Date().toISOString();
    this.child = spawn(this.powershell, args, {
      cwd: path.dirname(this.script),
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.pid = this.child.pid || 0;
    if (this.child.stderr) {
      this.child.stderr.on("data", (chunk) => {
        this.appendLog(String(chunk));
      });
    }
    this.child.on("error", (error) => {
      this.appendLog("[ae_guard] spawn error: " + String(error && error.message) + "\r\n");
    });
    this.child.on("exit", () => {
      this.child = null;
      this.pid = 0;
    });
    this.appendLog(
      "[" + this.stamp() +
        "] guard spawned by hub: pid=" + this.pid + " timeout=" + timeoutSec +
        "s interval=" + intervalMs + "ms\r\n",
    );
    return { ok: true, pid: this.pid };
  }

  stop() {
    if (!this.isRunning()) return { ok: false, reason: "not_running" };
    const pid = this.pid;
    try {
      spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    }
    this.appendLog(
      "[" + this.stamp() +
        "] guard stopped by hub: pid=" + pid + "\r\n",
    );
    this.child = null;
    this.pid = 0;
    return { ok: true, pid };
  }

  logTail(lines = 20) {
    const n = Math.floor(Number(lines));
    if (!this.logPath || !Number.isFinite(n) || n <= 0) return "";
    try {
      return fs
        .readFileSync(this.logPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-n)
        .join("\n");
    } catch {
      return "";
    }
  }

  snapshot() {
    return {
      running: this.isRunning(),
      pid: this.pid,
      startedAt: this.startedAt,
      options: this.options,
      logTail: this.logTail(12),
    };
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

module.exports = { AeGuardJob };
