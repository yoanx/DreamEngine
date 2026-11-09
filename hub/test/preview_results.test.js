/* ============================================================
 * preview_results 的账本读写：一次运行一份文件、Hub 写 skip、脚本写 ok/fail。
 * 第 5 步的统计完全依赖这里，所以解析要容忍 BOM、空行、表头与列数不足。
 * ============================================================ */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const results = require("../core/preview_results");

function makePaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "de-preview-results-"));
  const probe = path.join(dir, "Probe");
  return { dir, probe, previewResults: path.join(probe, "preview_run_results.tsv") };
}

test("beginRun 清空旧账本并写入 Hub 侧的 skip 行", () => {
  const paths = makePaths();
  fs.mkdirSync(paths.probe, { recursive: true });
  fs.writeFileSync(paths.previewResults, "旧行\t不该留下\r\n", "utf8");

  results.beginRun(paths, {
    kind: "effect",
    skips: [
      { key: "ADBE Glo2", name: "Glow", status: "skip", reason: "already_rendered" },
      { key: "PEDG2", name: "Deep Glow", status: "skip", reason: "blacklisted" },
    ],
  });

  const rows = results.readRows(paths);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "effect");
  assert.equal(rows[0].key, "ADBE Glo2");
  assert.equal(rows[0].status, "skip");
  assert.equal(rows[0].reason, "already_rendered");
  assert.equal(rows[1].reason, "blacklisted");
});

test("脚本追加的 ok / fail 行能与 skip 行合并成统计", () => {
  const paths = makePaths();
  results.beginRun(paths, { kind: "preset", skips: [{ key: "a.ffx", reason: "already_rendered" }] });
  results.appendRows(paths, [
    { kind: "preset", key: "b.ffx", name: "B", status: "ok" },
    { kind: "preset", key: "c.ffx", name: "C", status: "fail", reason: "render_timeout" },
  ]);

  const { rows, summary } = results.read(paths);
  assert.equal(rows.length, 3);
  assert.equal(summary.total, 3);
  assert.equal(summary.ok, 1);
  assert.equal(summary.fail, 1);
  assert.equal(summary.skip, 1);
  assert.equal(summary.failures[0].key, "c.ffx");
  assert.equal(summary.failures[0].reasonLabel, "渲染超时");
  assert.equal(summary.skipReasons.already_rendered, 1);
});

test("解析容忍 BOM、空行、表头与列数不足", () => {
  const paths = makePaths();
  fs.mkdirSync(paths.probe, { recursive: true });
  fs.writeFileSync(
    paths.previewResults,
    "\uFEFFtime\tkind\tkey\tname\tstatus\treason\r\n" +
      "\r\n" +
      "16:04:11\tpreset\tp1.ffx\tP1\tok\t\r\n" +
      "16:04:12\tpreset\tp2.ffx\r\n",
    "utf8",
  );

  const rows = results.readRows(paths);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "ok");
  assert.equal(rows[1].key, "p2.ffx");
  assert.equal(rows[1].status, "");
});

test("skipsFromCatalog 把 catalog 状态映射成账本原因", () => {
  const rows = results.skipsFromCatalog("effect", [
    { matchName: "A", status: "rendered" },
    { matchName: "B", status: "blacklisted", reason: "crash" },
    { matchName: "C", status: "no_preview" },
    { matchName: "D", status: "unknown" },
  ]);
  assert.deepEqual(
    rows.map((row) => row.reason),
    ["already_rendered", "blacklisted", "no_preview", "unknown"],
  );
  assert.equal(rows[0].status, "skip");
  assert.equal(rows[0].name, "A");
});

test("未开始运行的路径返回空数组而不是抛错", () => {
  const paths = makePaths();
  assert.deepEqual(results.readRows(paths), []);
  assert.deepEqual(results.read(paths).summary, {
    total: 0,
    ok: 0,
    fail: 0,
    skip: 0,
    failures: [],
    skipped: [],
    failReasons: {},
    skipReasons: {},
  });
  results.clear(paths);
  assert.equal(fs.existsSync(paths.previewResults), false);
});
