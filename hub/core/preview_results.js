/* ============================================================
 * preview_results.js —— 预览渲染的逐条结果账本
 *
 * 一次预览渲染只对应一份文件：<Probe>/preview_run_results.tsv
 *   time \t kind \t key \t name \t status \t reason
 *
 * 谁写什么：
 *   · Hub 在运行开始时清空文件，并补写自己在启动前过滤掉的条目（status=skip）
 *   · 两套渲染脚本逐条追加 ok / fail，以及它们自己跳过的条目（skip）
 * 所以第 5 步的「成功/失败/跳过」只需要读这一份文件，不用 grep 日志、
 * 也不用去 diff 黑名单。日志仍然保留，作为「查看详情」的内容。
 *
 * 不依赖 electron，可脱离 GUI 用 Node 直接测。
 * ============================================================ */

const fs = require("node:fs");

const COLUMNS = ["time", "kind", "key", "name", "status", "reason"];

/** 跳过原因：与渲染脚本、第 5 步分组标题保持一致 */
const SKIP_REASONS = {
  already_rendered: "已生成",
  blacklisted: "黑名单",
  excluded: "不可渲染",
  no_preview: "无预览资格",
  unknown: "目录中不存在",
};

const FAIL_REASONS = {
  render_error: "渲染报错",
  render_timeout: "渲染超时",
  ae_dialog: "AE 弹窗卡住",
  crash: "进程崩溃",
  no_preview: "无预览资格",
  excluded: "不可渲染",
  blacklisted: "黑名单",
};

function cleanCell(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

function nowTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 把 catalog.filterSelection 的 skipped 映射成账本行 */
function skipsFromCatalog(kind, skipped) {
  const rows = [];
  for (const item of skipped || []) {
    if (!item || !item.matchName) continue;
    const status = String(item.status || "unknown");
    rows.push({
      kind,
      key: item.matchName,
      name: item.displayName || item.name || item.matchName,
      status: "skip",
      reason: status === "rendered" ? "already_rendered" : status,
    });
  }
  return rows;
}

/**
 * 开始一轮新的运行：清空账本并写入 Hub 侧的跳过行。
 * @param {ReturnType<import("./paths").createPaths>} paths
 * @param {{kind?: string, skips?: Array<{kind?:string,key:string,name?:string,status?:string,reason?:string}>}} [options]
 */
function beginRun(paths, options = {}) {
  const kind = String(options.kind || "preset");
  fs.mkdirSync(paths.probe, { recursive: true });
  // 先截断：脚本只追加、不截断，谁开始一次运行谁负责清零
  fs.writeFileSync(paths.previewResults, "", "utf8");
  const rows = (options.skips || []).map((row) => ({
    kind: String(row.kind || kind),
    key: row.key,
    name: row.name,
    status: row.status || "skip",
    reason: row.reason || "",
  }));
  appendRows(paths, rows);
  return { ok: true, path: paths.previewResults, skipped: rows.length };
}

/** 追加结果行（Hub 只用来写 skip；脚本用 Add-Content 写 ok/fail） */
function appendRows(paths, rows) {
  if (!rows || rows.length === 0) return 0;
  fs.mkdirSync(paths.probe, { recursive: true });
  const time = nowTime();
  const text = rows
    .map((row) => {
      const cells = [
        cleanCell(row.time || time),
        cleanCell(row.kind),
        cleanCell(row.key),
        cleanCell(row.name || row.key),
        cleanCell(row.status),
        cleanCell(row.reason),
      ];
      return cells.join("\t");
    })
    .join("\r\n");
  const file = paths.previewResults;
  const exists = fs.existsSync(file) && fs.statSync(file).size > 0;
  fs.appendFileSync(file, (exists ? "\r\n" : "") + text + "\r\n", "utf8");
  return rows.length;
}

/** 读账本；容忍 BOM、空行、列数不足的行 */
function readRows(paths) {
  let text = "";
  try {
    text = fs.readFileSync(paths.previewResults, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split("\t");
    if (cells[0] === "time") continue; // 兼容将来可能加的表头
    const row = {};
    COLUMNS.forEach((name, index) => {
      row[name] = cleanCell(cells[index]);
    });
    if (!row.key && !row.status) continue;
    rows.push(row);
  }
  return rows;
}

function labelFor(status, reason) {
  const table = status === "skip" ? SKIP_REASONS : FAIL_REASONS;
  return table[reason] || reason || "";
}

/**
 * 汇总成第 5 步要的三个数 + 明细。
 * @param {ReturnType<typeof readRows>} rows
 */
function summarize(rows) {
  const summary = {
    total: 0,
    ok: 0,
    fail: 0,
    skip: 0,
    failures: [],
    skipped: [],
    failReasons: {},
    skipReasons: {},
  };
  for (const row of rows || []) {
    summary.total++;
    if (row.status === "ok") {
      summary.ok++;
    } else if (row.status === "fail") {
      summary.fail++;
      summary.failReasons[row.reason] = (summary.failReasons[row.reason] || 0) + 1;
      summary.failures.push({
        key: row.key,
        name: row.name,
        reason: row.reason,
        reasonLabel: labelFor("fail", row.reason),
        time: row.time,
      });
    } else if (row.status === "skip") {
      summary.skip++;
      summary.skipReasons[row.reason] = (summary.skipReasons[row.reason] || 0) + 1;
      summary.skipped.push({
        key: row.key,
        name: row.name,
        reason: row.reason,
        reasonLabel: labelFor("skip", row.reason),
      });
    }
  }
  return summary;
}

/** IPC 用：读文件 + 汇总一次返回 */
function read(paths) {
  const rows = readRows(paths);
  return { ok: true, path: paths.previewResults, rows, summary: summarize(rows) };
}

/** 清空账本（新流程进入第 1 步时用，避免上一轮数字残留在第 5 步） */
function clear(paths) {
  try {
    fs.rmSync(paths.previewResults, { force: true });
  } catch {
    /* 无所谓 */
  }
  return { ok: true };
}

module.exports = {
  COLUMNS,
  SKIP_REASONS,
  FAIL_REASONS,
  beginRun,
  appendRows,
  readRows,
  summarize,
  read,
  clear,
  skipsFromCatalog,
  labelFor,
  nowTime,
  cleanCell,
};
