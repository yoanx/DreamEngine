const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("两个离线渲染脚本接收共用预览根目录", () => {
  const preset = read("tools/generate_plugin_presets.ps1");
  const effect = read("tools/generate_plugin_effects.ps1");
  assert.match(preset, /\[string\]\$PreviewRoot/);
  assert.match(effect, /\[string\]\$PreviewRoot/);
  assert.match(preset, /preset_preview_root\.txt/);
  assert.match(effect, /plugin_preview_root\.txt/);
});

test("预设渲染器把产物写入 presets 子目录并使用 previews/presets 索引路径", () => {
  const ps1 = read("tools/generate_plugin_presets.ps1");
  const jsx = read("tools/run_plugin_preset_preview.jsx");
  const preview = read("cep/com.dreamengine.panel/engine/preset_preview.jsx");
  assert.match(ps1, /previews\/presets/);
  assert.match(jsx, /PREVIEW_ROOT|previewRoot/);
  assert.match(preview, /previewRoot/);
});

test("效果渲染器把产物写入 effects 子目录并使用 previews/effects 索引路径", () => {
  const jsx = read("tools/run_plugin_preview.jsx");
  const preview = read("cep/com.dreamengine.panel/engine/previewgen.jsx");
  assert.match(jsx, /PREVIEW_ROOT|previewRoot/);
  assert.match(preview, /options\.previewRoot/);
  assert.match(preview, /previews\/effects/);
});
