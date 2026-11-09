/* effect_param_cache 的单测：合并 → 索引 → 读取 → 覆盖 / 删除。 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createPaths } = require("../core/paths");
const cache = require("../core/effect_param_cache");

const COLUMNS = [
  "indexPath",
  "path",
  "name",
  "type",
  "value",
  "canAnimate",
  "hasMin",
  "min",
  "hasMax",
  "max",
  "aux",
  "safe",
  "reason",
];
const DUMP_HEADER = COLUMNS.join("\t");

function tmpPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-effect-params-"));
  const paths = createPaths({ docsDir: root, appData: path.join(root, "AppData") });
  fs.mkdirSync(paths.userRoot, { recursive: true });
  fs.mkdirSync(paths.probe, { recursive: true });
  return paths;
}

/* 与 manual_probe.jsx 的 safeLabel 一致 */
function safeLabel(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_");
}

function dumpText(rows) {
  return [DUMP_HEADER].concat(rows).join("\r\n") + "\r\n";
}

/**
 * 造一条原始 dump：<probe>/effect_params_raw/<stamp>/<safe>/p0_dump.tsv + meta.json
 */
function writeRaw(paths, stamp, meta, rows) {
  const dir = path.join(paths.effectParamsRaw, stamp, safeLabel(meta.matchName));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "p0_dump.tsv"), dumpText(rows), "utf8");
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({
      matchName: meta.matchName,
      plugin: meta.plugin || "",
      category: meta.category || "",
      safe: safeLabel(meta.matchName),
      aeVersion: meta.aeVersion || "25.0",
      leaves: rows.length,
      fetchedAt: meta.fetchedAt || "2026-11-09T08:00:00.000Z",
    }),
    "utf8",
  );
  return dir;
}

function glowRows(threshold) {
  return [
    ["0.0", "Glow / Glow Threshold", "Glow Threshold", "OneD", String(threshold), "1", "1", "0", "1", "100", "0", "1", ""].join("\t"),
    ["1.0", "Glow / Glow Color", "Glow Color", "Color", "[1,1,1]", "0", "", "", "", "", "0", "1", ""].join("\t"),
    ["2.0", "Glow / Glow Note", "Glow Note", "TextDocument", "hello", "0", "", "", "", "", "1", "1", ""].join("\t"),
  ];
}

test("mergeRound → readIndex → readEffect 往返", () => {
  const paths = tmpPaths();
  writeRaw(paths, "20261109-170000", {
    matchName: "ADBE Glo2",
    plugin: "Glow",
    category: "Stylize",
  }, glowRows(50));

  const merged = cache.mergeRound(paths, { aeVersion: "25.0", aeMajor: 2025 });
  assert.equal(merged.ok, true);
  assert.equal(merged.merged, 1);
  assert.equal(merged.groups.length, 1);
  assert.equal(merged.groups[0].file, "Glow__Stylize.tsv");

  const index = cache.readIndex(paths);
  assert.equal(index.ok, true);
  assert.equal(index.missing, undefined);
  assert.equal(index.items.length, 1);
  const item = index.items[0];
  assert.equal(item.matchName, "ADBE Glo2");
  assert.equal(item.plugin, "Glow");
  assert.equal(item.category, "Stylize");
  assert.equal(item.aeVersion, "25.0");
  assert.equal(item.aeMajor, 2025);
  assert.equal(item.count, 3);
  assert.ok(item.fetchedAt);

  const effect = cache.readEffect(paths, "ADBE Glo2");
  assert.equal(effect.ok, true);
  assert.equal(effect.meta.plugin, "Glow");
  assert.equal(effect.meta.category, "Stylize");
  assert.equal(effect.params.length, 3);

  const threshold = effect.params[0];
  assert.equal(threshold.indexPath, "0.0");
  assert.equal(threshold.name, "Glow Threshold");
  assert.equal(threshold.type, "OneD");
  assert.equal(threshold.value, 50);
  assert.equal(threshold.valueText, "50");
  assert.equal(threshold.valueType, "number");
  assert.equal(threshold.depth, 2);
  assert.equal(threshold.group, "Glow");
  assert.equal(threshold.leaf, true);
  assert.equal(threshold.readOnly, false);
  assert.equal(threshold.hasMin, true);
  assert.equal(threshold.min, 0);
  assert.equal(threshold.hasMax, true);
  assert.equal(threshold.max, 100);

  const color = effect.params[1];
  assert.deepEqual(color.value, [1, 1, 1]);
  assert.equal(color.valueType, "array");
  assert.equal(color.readOnly, false);

  const note = effect.params[2];
  assert.equal(note.valueType, "text");
  assert.equal(note.readOnly, true);

  // UTF-8 无 BOM + CRLF
  const file = path.join(paths.effectParamsRoot, "Glow__Stylize.tsv");
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.charCodeAt(0), "#".charCodeAt(0));
  assert.ok(text.includes("\r\n"));
  assert.ok(fs.existsSync(path.join(paths.effectParamsRoot, "index.json")));
});

test("同一 matchName 后写覆盖先写，重复合并幂等", () => {
  const paths = tmpPaths();
  writeRaw(paths, "20261109-170000", {
    matchName: "ADBE Glo2",
    plugin: "Glow",
    category: "Stylize",
    fetchedAt: "2026-11-09T08:00:00.000Z",
  }, glowRows(50));
  cache.mergeRound(paths, { aeVersion: "25.0", aeMajor: 2025 });

  writeRaw(paths, "20261109-171000", {
    matchName: "ADBE Glo2",
    plugin: "Glow",
    category: "Stylize",
    fetchedAt: "2026-11-09T09:00:00.000Z",
  }, [glowRows(80)[0]]);

  const once = cache.mergeRound(paths, { aeVersion: "25.0", aeMajor: 2025 });
  assert.equal(once.ok, true);
  const file = path.join(paths.effectParamsRoot, "Glow__Stylize.tsv");
  const afterFirst = fs.readFileSync(file, "utf8");
  const effect = cache.readEffect(paths, "ADBE Glo2");
  assert.equal(effect.params.length, 1);
  assert.equal(effect.params[0].value, 80);
  assert.equal(cache.readIndex(paths).items[0].count, 1);

  const twice = cache.mergeRound(paths, { aeVersion: "25.0", aeMajor: 2025 });
  assert.equal(twice.ok, true);
  assert.equal(fs.readFileSync(file, "utf8"), afterFirst);
});

test("多个 plugin + category 分组并存", () => {
  const paths = tmpPaths();
  writeRaw(paths, "20261109-170000", {
    matchName: "ADBE Glo2",
    plugin: "Glow",
    category: "Stylize",
  }, glowRows(50));
  writeRaw(paths, "20261109-170000", {
    matchName: "BCC Blur",
    plugin: "BCC",
    category: "Blur",
  }, [["0.0", "Blur / Radius", "Radius", "OneD", "12", "1", "1", "0", "1", "500", "0", "1", ""].join("\t")]);

  const merged = cache.mergeRound(paths, { aeVersion: "25.0", aeMajor: 2025 });
  assert.equal(merged.merged, 2);
  const files = fs.readdirSync(paths.effectParamsRoot).filter((name) => name.endsWith(".tsv")).sort();
  assert.deepEqual(files, ["BCC__Blur.tsv", "Glow__Stylize.tsv"]);

  const index = cache.readIndex(paths);
  assert.equal(index.items.length, 2);
  assert.deepEqual(
    index.groups.map((group) => group.file).sort(),
    ["BCC__Blur.tsv", "Glow__Stylize.tsv"],
  );
  assert.equal(cache.readEffect(paths, "BCC Blur").params[0].value, 12);
  assert.equal(cache.readEffect(paths, "ADBE Glo2").params.length, 3);
});

test("无缓存时 readIndex 返回空、readEffect 返回 not_found", () => {
  const paths = tmpPaths();
  const index = cache.readIndex(paths);
  assert.equal(index.ok, true);
  assert.equal(index.missing, true);
  assert.deepEqual(index.items, []);
  assert.deepEqual(index.groups, []);

  const effect = cache.readEffect(paths, "ADBE Glo2");
  assert.equal(effect.ok, false);
  assert.equal(effect.reason, "not_found");
  assert.equal(cache.hasParam(paths, "ADBE Glo2"), false);
});

test("removeParams 只删指定的效果节", () => {
  const paths = tmpPaths();
  writeRaw(paths, "20261109-170000", {
    matchName: "ADBE Glo2",
    plugin: "Glow",
    category: "Stylize",
  }, glowRows(50));
  writeRaw(paths, "20261109-170000", {
    matchName: "ADBE Glo3",
    plugin: "Glow",
    category: "Stylize",
  }, glowRows(60));

  cache.mergeRound(paths, { aeVersion: "25.0", aeMajor: 2025 });
  assert.equal(cache.readIndex(paths).items.length, 2);

  const removed = cache.removeParams(paths, ["ADBE Glo2"]);
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, 1);
  assert.equal(cache.hasParam(paths, "ADBE Glo2"), false);
  assert.equal(cache.hasParam(paths, "ADBE Glo3"), true);
  assert.equal(cache.readIndex(paths).items.length, 1);
});
