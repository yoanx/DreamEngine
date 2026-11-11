const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HUB = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(HUB, relative), "utf8");

test("效果库提供预览包导入导出按钮，并通过 preload/main IPC 调用核心模块", () => {
  const html = read("renderer/index.html");
  const app = read("renderer/app.js");
  const preload = read("preload.js");
  const main = read("main.js");

  assert.match(html, /id="btnEffectPreviewImport"/);
  assert.match(html, /id="btnEffectPreviewExport"/);
  assert.match(app, /importEffectPreviewPackage\(/);
  assert.match(app, /exportEffectPreviewPackage\(/);
  assert.match(preload, /effect-previews:import/);
  assert.match(preload, /effect-previews:export/);
  assert.match(main, /require\("\.\/core\/preview_package"\)/);
  assert.match(main, /dialog\.showOpenDialog/);
  assert.match(main, /dialog\.showSaveDialog/);
});

test("导出效果预览包时可以按插件选择", () => {
  const html = read("renderer/index.html");
  const app = read("renderer/app.js");
  const preload = read("preload.js");
  const main = read("main.js");
  assert.match(html, /id="effectExportDialog"/);
  assert.match(html, /id="effectExportPluginList"/);
  assert.match(html, /id="effectExportConfirm"/);
  assert.match(app, /function openEffectExportDialog/);
  assert.match(app, /exportEffectPreviewPackage\(\{\s*plugins/);
  assert.match(preload, /exportEffectPreviewPackage:\s*\(options\)/);
  assert.match(main, /exportEffectPreviews\([\s\S]*result\.filePath[\s\S]*options/);
});

test("Hub 效果卡优先使用单文件动画 WebP，不预加载整组 PNG 帧", () => {
  const app = read("renderer/app.js");
  const css = read("renderer/style.css");
  assert.match(app, /item\.webpSrc/);
  assert.match(app, /item\.stillSrc/);
  assert.match(app, /effect-preview-webp/);
  assert.match(app, /removeAttribute\("src"\)/);
  assert.match(css, /\.effect-preview-webp/);
});

test("效果渲染结束后自动生成 WebP，并通知效果库刷新", () => {
  const app = read("renderer/app.js");
  const preload = read("preload.js");
  const main = read("main.js");
  assert.match(main, /effect_preview_builder/);
  assert.match(main, /buildEffectPreviews/);
  assert.match(main, /effect-previews:built/);
  assert.match(preload, /onEffectPreviewsBuilt/);
  assert.match(app, /onEffectPreviewsBuilt/);
  assert.match(app, /loadEffects\(\)/);
});

test("效果渲染进行中按批次生成 WebP，并只通知有新增产物的构建", () => {
  const main = read("main.js");
  assert.match(main, /onState: \(state\)[\s\S]*maybeBuildEffectPreviews\(state\)/);
  assert.match(main, /function maybeBuildEffectPreviews/);
  assert.match(main, /function runEffectPreviewBuild/);
  assert.match(main, /result\.built/);
});

test("从库进入渲染流程时不继承上次的强制重渲选项", () => {
  const flow = read("renderer/flow.js");
  assert.match(flow, /saved\.config[\s\S]{0,240}flow\.plan\.config\.force\s*=\s*false/);
});

test("非 WebP 回退预览默认显示中间帧", () => {
  const library = fs.readFileSync(
    path.resolve(HUB, "..", "cep/com.dreamengine.panel/js/library.js"),
    "utf8",
  );
  assert.match(library, /var still = stillIndex === undefined \? Math\.floor\(frameCount \/ 2\)/);
  assert.match(library, /var stillIndex = undefined/);
});

test("预览渲染流程使用统一效果选择，只排除不可渲染条目", () => {
  const flow = read("renderer/flow.js");
  const html = read("renderer/index.html");
  assert.match(flow, /function effectItems\(\)[\s\S]*item\.renderable !== false/);
  assert.match(html, /把内置或插件效果加到测试图层上/);
});

test("效果渲染确认页隐藏预设帧率字段", () => {
  const css = read("renderer/style.css");
  assert.match(
    css,
    /#viewRender \.flow-config \.field\[hidden\]\s*\{[^}]*display:\s*none\s*!important/s,
  );
});
