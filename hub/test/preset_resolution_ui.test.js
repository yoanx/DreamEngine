const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("预设渲染确认页提供 360/720 分辨率并贯通到渲染脚本", () => {
  const html = read("hub/renderer/index.html");
  const flow = read("hub/renderer/flow.js");
  const ps1 = read("tools/generate_plugin_presets.ps1");
  const jsx = read("tools/run_plugin_preset_preview.jsx");
  const preset = read("cep/com.dreamengine.panel/engine/preset_preview.jsx");

  assert.match(html, /id="flowPresetResolution"/);
  assert.match(html, /value="360"[^>]*>360 × 360/);
  assert.match(html, /value="720"[^>]*>720 × 720/);
  assert.match(flow, /presetResolution/);
  assert.match(flow, /cellSize: kind === "preset"/);
  assert.match(flow, /cellSize: flow\.kind === "preset"/);
  assert.match(flow, /cellSize:\s*\[360,\s*720\]\.includes/);
  assert.match(ps1, /\[ValidateSet\(360,\s*720\)\]/);
  assert.match(ps1, /preset_preview_cell_size\.txt/);
  assert.match(ps1, /sliceCellSize\s*=\s*\$entryCellSize/);
  assert.match(jsx, /preset_preview_cell_size\.txt/);
  assert.match(jsx, /cellSize:\s*previewCellSize/);
  assert.match(preset, /Number\(opts\.cellSize\)/);
});
