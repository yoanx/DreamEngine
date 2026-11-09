const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const catalog = require("../../hub/core/catalog");
const presets = require("../../hub/core/presets");
const { createPaths } = require("../../hub/core/paths");

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-catalog-"));
  const docs = path.join(root, "docs");
  const appData = path.join(root, "appdata");
  fs.mkdirSync(path.join(appData, "Adobe", "CEP", "extensions", "com.dreamengine.panel", "data"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(docs, "DreamEngine", "presets", "sub"), { recursive: true });
  fs.mkdirSync(path.join(docs, "DreamEngineProbe"), { recursive: true });
  const paths = createPaths({ docsDir: docs, appData });
  return { root, paths };
}

test("readCatalog: 缺失目录返回 no_catalog", () => {
  const { paths } = makeWorkspace();
  const result = catalog.readCatalog(paths);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_catalog");
  assert.deepEqual(result.items, []);
});

test("readCatalog: 合并 rendered / blacklisted / excluded / noPreview", () => {
  const { paths } = makeWorkspace();
  fs.writeFileSync(
    paths.pluginCatalog,
    [
      "matchName\tdisplayName\tcategory\tplugin\texcluded\treason\tnoPreview",
      "S_Glow\tSapphire Glow\tSapphire\tSapphire\t0\t\t0",
      "S_Blur\tSapphire Blur\tSapphire\tSapphire\t0\t\t0",
      "S_Crash\tSapphire Crash\tSapphire\tSapphire\t0\t\t0",
      "Pseudo/Foo\tFoo\tBad\t其它插件\t1\tpseudo\t0",
      "ADBE AudWave\tAudWave\tAudio\t其它插件\t0\t\t1",
    ].join("\r\n"),
    "utf8",
  );
  fs.writeFileSync(
    paths.pluginManifest,
    JSON.stringify({ version: 1, items: [{ matchName: "S_Glow" }] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(paths.dataDir, "plugin_blacklist.json"),
    JSON.stringify({ version: 1, items: [{ matchName: "S_Crash", reason: "crash" }] }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(paths.dataDir, "names.json"),
    JSON.stringify({ items: [{ matchName: "S_Glow", nameEn: "Glow", nameZh: "辉光" }] }),
    "utf8",
  );
  fs.writeFileSync(
    paths.pluginCatalogMeta,
    JSON.stringify({ aeMajor: 2025, aeVersion: "25.0", scannedAt: "2026-11-08T00:00:00Z" }),
    "utf8",
  );

  const result = catalog.readCatalog(paths);
  assert.equal(result.ok, true);
  assert.equal(result.aeMajor, 2025);
  assert.equal(result.counts.total, 5);
  assert.equal(result.counts.rendered, 1);
  assert.equal(result.counts.blacklisted, 1);
  assert.equal(result.counts.excluded, 1);
  assert.equal(result.counts.noPreview, 1);
  assert.equal(result.counts.pending, 1);

  const byName = new Map(result.items.map((item) => [item.matchName, item]));
  assert.equal(byName.get("S_Glow").status, "rendered");
  assert.equal(byName.get("S_Glow").nameZh, "辉光");
  assert.equal(byName.get("S_Glow").selectable, true);
  assert.equal(byName.get("S_Crash").status, "blacklisted");
  assert.equal(byName.get("S_Crash").reason, "crash");
  assert.equal(byName.get("Pseudo/Foo").status, "excluded");
  assert.equal(byName.get("Pseudo/Foo").reason, "pseudo");
  assert.equal(byName.get("Pseudo/Foo").selectable, false);
  assert.equal(byName.get("ADBE AudWave").status, "no_preview");
  assert.equal(byName.get("ADBE AudWave").selectable, false);
  assert.equal(byName.get("S_Blur").status, "pending");
});

test("filterSelection: 默认跳过已生成/黑名单，force 时放行", () => {
  const items = [
    { matchName: "A", status: "pending", selectable: true },
    { matchName: "B", status: "rendered", selectable: true },
    { matchName: "C", status: "blacklisted", selectable: true, reason: "crash" },
    { matchName: "D", status: "excluded", selectable: false },
  ];
  const cat = { items };
  const normal = catalog.filterSelection(cat, ["A", "B", "C", "D", "X", "A"], false);
  assert.deepEqual(normal.selected.map((item) => item.matchName), ["A"]);
  assert.equal(normal.skipped.length, 4); // B, C, D, X（A 去重）

  const forced = catalog.filterSelection(cat, ["A", "B", "C", "D"], true);
  assert.deepEqual(forced.selected.map((item) => item.matchName), ["A", "B", "C"]);
  assert.equal(forced.skipped.length, 1);
  assert.equal(forced.skipped[0].matchName, "D");
});

test("planSelection: 显式空选集仍是选集模式，不能退化成全量", () => {
  const cat = {
    items: [{ matchName: "A", status: "pending", selectable: true }],
  };

  const empty = catalog.planSelection(cat, [], false);
  assert.equal(empty.mode, "selection");
  assert.deepEqual(empty.selected, []);
  assert.deepEqual(empty.skipped, []);

  const all = catalog.planSelection(cat, undefined, false);
  assert.equal(all.mode, "all");
});

test("writeSelection: 无表头、tab 分隔、CRLF", () => {
  const { paths } = makeWorkspace();
  const count = catalog.writeSelection(paths, [
    { matchName: "S_Glow", frames: 6, plugin: "Sapphire" },
    { matchName: "S_Blur", plugin: "Sapphire" },
  ]);
  assert.equal(count, 2);
  const text = fs.readFileSync(paths.pluginSelection, "utf8");
  assert.equal(text, "S_Glow\t6\tSapphire\r\nS_Blur\t6\tSapphire\r\n");
});

test("presets.list: 递归扫描子目录", () => {
  const { paths } = makeWorkspace();
  fs.writeFileSync(path.join(paths.presets, "a.ffx"), "x", "utf8");
  fs.writeFileSync(path.join(paths.presets, "sub", "b.ffx"), "x", "utf8");
  fs.writeFileSync(path.join(paths.presets, "sub", "note.txt"), "x", "utf8");

  const result = presets.list(paths);
  assert.equal(result.exists, true);
  const names = result.items.map((item) => item.fileName).sort();
  assert.deepEqual(names, ["a.ffx", "b.ffx"]);
});

test("presets: 库内路径校验支持子目录，拒绝库外", () => {
  const { paths, root } = makeWorkspace();
  const inside = path.join(paths.presets, "sub", "b.ffx");
  fs.writeFileSync(inside, "x", "utf8");
  assert.equal(presets.isInsideLibrary(paths, inside), true);
  assert.equal(presets.isInsideLibrary(paths, paths.presets), false);
  assert.equal(presets.isInsideLibrary(paths, path.join(root, "outside.ffx")), false);
});

test("presets.resolveSelection: 只保留库内真实 .ffx 并去重", () => {
  const { paths, root } = makeWorkspace();
  const a = path.join(paths.presets, "a.ffx");
  const b = path.join(paths.presets, "sub", "b.ffx");
  fs.writeFileSync(a, "x", "utf8");
  fs.writeFileSync(b, "x", "utf8");
  const outside = path.join(root, "outside.ffx");
  fs.writeFileSync(outside, "x", "utf8");
  const result = presets.resolveSelection(paths, [
    a,
    b,
    a,
    outside,
    path.join(paths.presets, "missing.ffx"),
    path.join(paths.presets, "not-ffx.txt"),
  ]);
  assert.deepEqual(result, [a, b]);
});
