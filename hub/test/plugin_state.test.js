/* ============================================================
 * plugin_state.jsx 纯逻辑断言（Node + node:vm）
 *
 * engine/*.jsx 是 ExtendScript，不能直接 require；这里用 vm 当普通脚本
 * 执行后取全局 AEV_PluginState 验证：
 *   1. 旧调用（4 参 planRun / 3 参 planStats）行为完全不变
 *   2. force + skip 语义（忽略 entries/blacklist、只跳过 skip）
 *   3. removeBlacklist 返回新对象、不修改入参
 *
 * 运行：node --test test/plugin_state.test.js
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const workspace = path.resolve(__dirname, "..", "..");
const sourcePath = path.join(
  workspace,
  "cep",
  "com.dreamengine.panel",
  "engine",
  "plugin_state.jsx",
);
const source = fs.readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, "");

// runInThisContext 让脚本与测试同处一个 realm，避免 vm 数组/对象跨 realm
// 导致的 deepStrictEqual 原型不一致（校验逻辑本身不受影响）。
vm.runInThisContext(source, { filename: "plugin_state.jsx" });
const PS = globalThis.AEV_PluginState;
assert.ok(PS, "plugin_state.jsx 没有导出 AEV_PluginState");
assert.equal(typeof PS.planRun, "function");
assert.equal(typeof PS.planStats, "function");
assert.equal(typeof PS.removeBlacklist, "function");

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log("ok - " + label);
}

/* ---------------- 旧调用：完全不变 ---------------- */

const todo = [
  { matchName: "a", frames: 8, plugin: "Sapphire" },
  { matchName: "b" },
  { matchName: "c", frames: 3, plugin: "BCC" },
  { matchName: "d" },
];
const entries = [{ matchName: "b", sheet: 1000 }];
const blacklist = { c: "crash" };

check("planRun 旧 4 参调用：跳过已完成/黑名单", () => {
  const run = PS.planRun(todo, entries, blacklist, 10);
  assert.deepEqual(
    run.map((item) => item.matchName),
    ["a", "d"],
  );
  assert.deepEqual(run[0], {
    matchName: "a",
    frames: 8,
    plugin: "Sapphire",
    displayName: "a",
    previewKey: "",
  });
  // 旧填充默认值：frames -> 6，plugin -> 其它插件
  assert.deepEqual(run[1], {
    matchName: "d",
    frames: 6,
    plugin: "其它插件",
    displayName: "d",
    previewKey: "",
  });
});

check("planRun 旧调用限流 + limit 0/负数 = 不限流", () => {
  assert.deepEqual(
    PS.planRun(todo, [], {}, 1).map((item) => item.matchName),
    ["a"],
  );
  assert.deepEqual(
    PS.planRun(todo, [], {}, 0).map((item) => item.matchName),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(
    PS.planRun(todo, [], {}, -1).map((item) => item.matchName),
    ["a", "b", "c", "d"],
  );
});

check("planRun 旧调用显式 undefined options 结果相同", () => {
  assert.deepEqual(
    PS.planRun(todo, entries, blacklist, 10, undefined),
    PS.planRun(todo, entries, blacklist, 10),
  );
});

check("planStats 旧 3 参调用：total/done/blacklisted/pending", () => {
  assert.deepEqual(PS.planStats(todo, entries, blacklist), {
    total: 4,
    done: 1,
    blacklisted: 1,
    pending: 2,
  });
  // 空 todo：旧行为 total=0
  assert.deepEqual(PS.planStats([], [], {}), {
    total: 0,
    done: 0,
    blacklisted: 0,
    pending: 0,
  });
});

/* ---------------- force + skip：新语义 ---------------- */

check("planRun force:true 忽略 entries/blacklist，只跳过 skip", () => {
  const run = PS.planRun(todo, entries, blacklist, 10, {
    force: true,
    skip: { a: true },
  });
  assert.deepEqual(
    run.map((item) => item.matchName),
    ["b", "c", "d"],
  );
});

check("planRun force:true 仍遵守 limit", () => {
  const run = PS.planRun(todo, entries, blacklist, 2, {
    force: true,
    skip: {},
  });
  assert.deepEqual(
    run.map((item) => item.matchName),
    ["a", "b"],
  );
});

check("planRun 非 force 时 options.skip 也生效（向后兼容增量）", () => {
  const run = PS.planRun(todo, entries, blacklist, 10, { skip: { a: true } });
  assert.deepEqual(
    run.map((item) => item.matchName),
    ["d"],
  );
});

check("planStats force:total=todo.length，done=skip 中属于 todo 的数量", () => {
  const stats = PS.planStats(todo, entries, blacklist, {
    force: true,
    skip: { a: true, b: true, zz: true },
  });
  assert.deepEqual(stats, {
    total: 4,
    done: 2,
    blacklisted: 0,
    pending: 2,
  });
});

check("planStats force:全部 processed 后 pending=0", () => {
  const stats = PS.planStats(todo, [], {}, {
    force: true,
    skip: { a: true, b: true, c: true, d: true },
  });
  assert.deepEqual(stats, {
    total: 4,
    done: 4,
    blacklisted: 0,
    pending: 0,
  });
});

check("planStats force:skip 不修改 todo/entries/blacklist", () => {
  const skip = { a: true };
  PS.planStats(todo, entries, blacklist, { force: true, skip });
  assert.deepEqual(Object.keys(skip), ["a"]);
  assert.deepEqual(
    todo.map((item) => item.matchName),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(blacklist, { c: "crash" });
});

/* ---------------- removeBlacklist ---------------- */

check("removeBlacklist 返回新对象、不修改入参", () => {
  const original = { a: "crash", b: "render_error", c: "crash" };
  const snapshot = Object.assign({}, original);
  const next = PS.removeBlacklist(original, ["b", "c", "not-there"]);
  assert.notEqual(next, original);
  assert.deepEqual(next, { a: "crash" });
  assert.deepEqual(original, snapshot);
});

check("removeBlacklist 空名单/空 map 安全", () => {
  assert.deepEqual(PS.removeBlacklist({ a: "crash" }, []), { a: "crash" });
  assert.deepEqual(PS.removeBlacklist({}, ["a"]), {});
});

check("buildManifest 保留 WebP 引用字段", () => {
  const doc = JSON.parse(PS.buildManifest([{
    matchName: "ADBE Glo2",
    sheet: 1000,
    frames: 24,
    fps: 24,
    previewVersion: 2,
    frameTemplate: "thumbs/batch_1000_%04d.png",
    plugin: "内置",
    webpSrc: "thumbs/webp/ADBE Glo2.webp",
    stillSrc: "thumbs/webp/stills/ADBE Glo2.webp",
    stillFrame: 12,
  }], { cellSize: 720, columns: 1 }));
  assert.equal(doc.items[0].webpSrc, "thumbs/webp/ADBE Glo2.webp");
  assert.equal(doc.items[0].stillSrc, "thumbs/webp/stills/ADBE Glo2.webp");
  assert.equal(doc.items[0].stillFrame, 12);
});

check("预览索引往返稳定键，并按稳定键替换旧 matchName", () => {
  const first = {
    matchName: "BCC_GLOW_OLD",
    displayName: "BCC Glow",
    previewKey: "bcc::bcc glow",
    sheet: 1000,
    frames: 24,
    fps: 24,
    duration: 1,
    previewVersion: 2,
    frameTemplate: "thumbs/batch_1000_%04d.png",
    plugin: "BCC",
  };
  const roundTrip = PS.readEntries(PS.entriesTsv([first]));
  assert.equal(roundTrip[0].displayName, "BCC Glow");
  assert.equal(roundTrip[0].previewKey, "bcc::bcc glow");

  const replaced = PS.addEntry(roundTrip, {
    ...first,
    matchName: "BCC_GLOW_V2",
    sheet: 1001,
  });
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].matchName, "BCC_GLOW_V2");

  const manifest = JSON.parse(PS.buildManifest(replaced, {}));
  assert.equal(manifest.items[0].displayName, "BCC Glow");
  assert.equal(manifest.items[0].previewKey, "bcc::bcc glow");
});

check("mergePreviewFields 按 matchName 保留 WebP 引用", () => {
  const merged = PS.mergePreviewFields(
    [{ matchName: "a" }, { matchName: "b" }],
    [{ matchName: "a", webpSrc: "a.webp", stillSrc: "stills/a.webp", stillFrame: 12 }],
  );
  assert.equal(merged[0].webpSrc, "a.webp");
  assert.equal(merged[0].stillSrc, "stills/a.webp");
  assert.equal(merged[0].stillFrame, 12);
  assert.equal(merged[1].webpSrc, undefined);
});

/* ---------------- 顺带验证黑名单/日志的基本契约 ---------------- */

check("readBlacklist / mergeBlacklist / removeBlacklist 可串联", () => {
  const map = PS.readBlacklist("matchName\treason\r\na\tcrash\r\nb\trender_error");
  assert.deepEqual(map, { a: "crash", b: "render_error" });
  const merged = PS.mergeBlacklist(map, ["c"], "crash");
  assert.deepEqual(merged, { a: "crash", b: "render_error", c: "crash" });
  const pruned = PS.removeBlacklist(merged, ["a", "c"]);
  assert.deepEqual(pruned, { b: "render_error" });
  assert.deepEqual(map, { a: "crash", b: "render_error" });
});

console.log("\nplugin_state.test.js: " + passed + " assertions passed");
