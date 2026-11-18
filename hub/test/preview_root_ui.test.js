const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HUB = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(HUB, relative), "utf8");

test("设置页提供共用预览产物目录，并通过主进程迁移", () => {
  const html = read("renderer/index.html");
  const app = read("renderer/app.js");
  const preload = read("preload.js");
  const main = read("main.js");

  assert.match(html, /id="setPreviewRoot"/);
  assert.match(html, /id="btnChoosePreviewRoot"/);
  assert.match(html, /id="btnResetPreviewRoot"/);
  assert.match(html, /id="btnOpenPreviewRoot"/);
  assert.match(html, /id="setPreviewSize"/);
  assert.match(app, /function choosePreviewRoot/);
  assert.match(app, /function resetPreviewRoot/);
  assert.match(app, /resetPreviewRoot\(\)/);
  assert.match(preload, /choosePreviewRoot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("preview-root:choose"\)/);
  assert.match(preload, /resetPreviewRoot:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("preview-root:reset"\)/);
  assert.match(main, /require\("\.\/core\/preview_paths"\)/);
  assert.match(main, /preview-root:choose/);
  assert.match(main, /preview-root:reset/);
  assert.match(main, /resetPreviewRoot/);
  assert.match(main, /migratePreviewRoot/);
  assert.match(main, /const previewRoot = previewPaths\.currentRoot\(paths\)/);
  assert.match(main, /previewRoot,/);
  assert.match(main, /storageInfo\(paths\)/);
  assert.match(app, /setPreviewSize/);
});
