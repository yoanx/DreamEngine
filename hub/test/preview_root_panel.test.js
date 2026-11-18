const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PANEL = path.resolve(__dirname, "..", "..", "cep/com.dreamengine.panel");
const read = (relative) => fs.readFileSync(path.join(PANEL, relative), "utf8");

test("CEP 面板读取预览根目录设置并把 previews/ 解析为本地文件 URL", () => {
  const library = read("js/library.js");
  assert.match(library, /data\/preview_settings\.json/);
  assert.match(library, /state\.previewRoot/);
  assert.match(library, /value\.indexOf\("previews\/"\)/);
  assert.match(library, /file:\/\/\//);
  assert.match(library, /rootLower\.indexOf\(extensionLower \+ "\/data\/"\)/);
  assert.match(library, /window\.cep\.fs\.readFile/);
  assert.match(library, /image\/webp/);
  assert.match(library, /result\.data/);
  assert.match(library, /preview-webp still/);
  assert.match(library, /animated\.src = stillUrl/);
});


test("滚动停止后恢复鼠标下卡片的预览播放", () => {
  const library = read("js/library.js");
  assert.match(library, /resumeHoveredPreviews/);
  assert.match(library, /document\.querySelectorAll\("\.effect-card:hover, \.preset-card:hover"\)/);
  assert.match(library, /aev:resume-preview/);
  assert.match(library, /previewResumeTimer = setTimeout/);
});


test("预设页刷新索引时重读 Hub 的预览根目录", () => {
  const library = read("js/library.js");
  assert.match(library, /function refreshPresetPreviews/);
  assert.match(library, /loadPreviewRoot\(function \(\) \{/);
  assert.match(library, /loadPresetIndex\(function \(\) \{/);
  assert.match(library, /function loadJson\(path, callback, cacheBust\)/);
  assert.match(library, /new Date\(\)\.getTime\(\)/);
  assert.match(library, /hasPresetPreview/);
  assert.match(library, /var stillUrl = preview\.stillSrc \? dataUrl/);
  assert.match(library, /preview\.stillFrame/);
  assert.match(library, /String\(result\.data\)\.replace\(\/\\s\/g, ""\)/);
});
