const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HUB = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(HUB, relative), "utf8");

test("效果和预设卡片整卡点击即可切换选中状态", () => {
  const app = read("renderer/app.js");
  assert.match(app, /function setEffectSelected/);
  assert.match(app, /function toggleEffectSelected/);
  assert.match(app, /card\.addEventListener\("click"/);
  assert.match(app, /toggleEffectSelected\(item\)/);
  assert.match(app, /target\.closest\("button, label, input, a"\)/);
  assert.match(app, /card\.setAttribute\("aria-pressed"/);
  assert.match(app, /function togglePresetSelected/);
  assert.match(app, /togglePresetSelected\(item\)/);
  assert.match(app, /presetHoldTriggeredPath/);
});
