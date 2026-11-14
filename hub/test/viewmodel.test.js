/* ============================================================
 * viewmodel.js 纯逻辑断言（Node + node:vm）
 *
 * 验证新增 excludeReason 的原因键，以及 isExcludable 与旧语义完全一致
 * （isExcludable(effect) === (excludeReason(effect) !== "")）。
 *
 * 运行：node --test test/viewmodel.test.js
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

const workspace = path.resolve(__dirname, "..", "..");
const sourcePath = path.join(workspace, "cep", "com.dreamengine.panel", "js", "viewmodel.js");
const source = fs.readFileSync(sourcePath, "utf8").replace(/^\uFEFF/, "");

vm.runInThisContext(source, { filename: "viewmodel.js" });
const VM = globalThis.AEV_ViewModel;
assert.ok(VM, "viewmodel.js 没有导出 AEV_ViewModel");
assert.equal(typeof VM.excludeReason, "function");
assert.equal(typeof VM.isExcludable, "function");

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log("ok - " + label);
}

const cases = [
  ["Pseudo/ 占位项", { matchName: "Pseudo/Placeholder", category: "Utility" }, "pseudo"],
  ["Obsolete 分类（英文）", { matchName: "ADBE Old", category: "Obsolete" }, "obsolete"],
  ["过时分类（中文）", { matchName: "x", category: "已过时" }, "obsolete"],
  ["分类为空", { matchName: "ADBE CM x", category: "" }, "no_category"],
  ["分类只有空白", { matchName: "ADBE CM x", category: "   " }, "no_category"],
  ["3D 通道（poor preview）", { matchName: "ADBE 3D Glasses", category: "3D Channel" }, "poor_preview"],
  ["音频族（poor preview）", { matchName: "ADBE AudWave", category: "音频" }, "poor_preview"],
  ["可渲效果", { matchName: "S_Glow", category: "Sapphire" }, ""],
  ["可渲效果（internal）", { matchName: "ADBE Gaussian Blur 2", category: "Blur & Sharpen" }, ""],
  ["空对象", {}, "no_category"],
];

check("excludeReason 原因键符合契约", () => {
  for (const [label, effect, expected] of cases) {
    assert.equal(VM.excludeReason(effect), expected, label);
  }
});

check("isExcludable === (excludeReason !== \"\")", () => {
  const extra = [
    { matchName: "ADBE Fractal", category: "Generate" },
    { matchName: "CC Hair", category: "Simulation" },
    { matchName: "BCC Glow", category: "BCC" },
    { matchName: "Videocopilot Optical Flares", category: "Video Copilot" },
    { matchName: "ADBE Numbers2", category: "Text" },
    { matchName: "ADBE Apply Color LUT2", category: "Utility" },
    { matchName: "CS CrossBlur", category: "Blur & Sharpen" },
    { matchName: "ADBE Echo", category: "Time" },
    { matchName: "RG Supercomp", category: "RG " },
    { matchName: "RE:Vision Twixtor", category: "RE:Vision" },
  ];
  for (const effect of cases.map((row) => row[1]).concat(extra)) {
    assert.equal(
      VM.isExcludable(effect),
      VM.excludeReason(effect) !== "",
      JSON.stringify(effect),
    );
  }
});

check("稳定预览键使用插件与显示名，忽略 matchName", () => {
  const key = VM.previewKey("BCC", "  BCC   Glow ");
  assert.equal(key, "bcc::bcc glow");
  assert.equal(
    VM.previewKeyFor({ matchName: "BCC_GLOW_V2", displayName: "BCC Glow", category: "BCC" }),
    key,
  );

  const preview = { matchName: "BCC_GLOW", previewKey: key, src: "thumb.png" };
  const item = VM.buildItem(
    { matchName: "BCC_GLOW_V2", displayName: "BCC Glow", category: "BCC" },
    {},
    {},
    {},
    { [key]: preview },
  );
  assert.equal(item.hasPreview, true);
  assert.equal(item.preview, preview);
});

console.log("\nviewmodel.test.js: " + passed + " assertions passed");
