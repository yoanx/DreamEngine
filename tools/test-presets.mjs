#!/usr/bin/env node
/* ============================================================
 * test-presets.mjs —— M3 预设库的静态回归
 *
 * 预设库最要紧的不是「能不能扫到文件」，而是**应用预设不能把用户的工程弄脏**：
 * T0.4 实测结论——applyPreset 对图层类型不匹配时静默无效，没有选中层时
 * 会自己新建图层。所以安全措施（清空选区、只选目标层、调用后比对、
 * 按类型顺序重试、remove() 删掉自动新建的图层）必须一直在。
 *
 * 用法：node tools/test-presets.mjs
 * ============================================================ */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/** 只看代码行：注释里常会提到被禁用的写法（说明「不要用它」） */
function codeOf(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
    .join("\n");
}

/* presets.jsx 顶层只是定义函数，不碰 app/File/Folder，可以直接在 vm 里加载 */
function loadPresets() {
  const ctx = vm.createContext({});
  vm.runInContext(read("cep/com.dreamengine.panel/engine/presets.jsx"), ctx);
  return ctx.AEV_Presets;
}

test(".ffx 判定只看后缀", () => {
  const p = loadPresets();
  assert.equal(p.isPresetFile("夜视.ffx"), true);
  assert.equal(p.isPresetFile("Night Vision.FFX"), true);
  assert.equal(p.isPresetFile("工程.aep"), false);
  assert.equal(p.isPresetFile("ffx"), false);
});

test("预设分类取所在目录名", () => {
  const p = loadPresets();
  assert.equal(p.categoryOf("C:/Presets/Text/3D Text/夜视.ffx"), "3D Text");
  assert.equal(p.categoryOf("C:\\Presets\\Image - Special Effects\\夜视.ffx"), "Image - Special Effects");
});

test("AE 面板预设库合并 Hub 的外部 AE 预设索引", () => {
  const root = "C:/Docs/DreamEngine/presets";
  const nested = root + "/Nested";
  const external = "C:/Program Files/Adobe/After Effects/Presets/Text/ext.ffx";
  const catalogText = JSON.stringify({
    version: 1,
    items: [{
      path: external,
      name: "ext",
      source: "Text",
      sourceKind: "install",
    }],
  });

  class FileMock {
    constructor(path) {
      this.fsName = String(path || "").replace(/\\/g, "/");
      this.name = this.fsName.split("/").pop();
      this.exists = true;
    }
    open() { return true; }
    read() { return catalogText; }
    close() {}
  }
  class FolderMock {
    constructor(path) {
      this.fsName = String(path || "").replace(/\\/g, "/");
      this.exists = true;
    }
    create() { return true; }
    getFiles() {
      if (this.fsName === root) {
        return [new FileMock(root + "/a.ffx"), new FolderMock(nested)];
      }
      if (this.fsName === nested) return [new FileMock(nested + "/b.ffx")];
      return [];
    }
  }
  FolderMock.myDocuments = { fsName: "C:/Docs" };

  const ctx = vm.createContext({
    File: FileMock,
    Folder: FolderMock,
    AEV_Store: {
      folderAt() { return new FolderMock(root); },
    },
  });
  vm.runInContext(read("cep/com.dreamengine.panel/engine/presets.jsx"), ctx);
  const data = JSON.parse(ctx.AEV_Presets.libraryJson());
  assert.equal(data.status, "ok");
  assert.equal(data.count, 3);
  assert.equal(data.externalCount, 1);
  assert.equal(data.items.filter((item) => item.external).length, 1);
  assert.equal(data.items.some((item) => item.path === external), true);
  assert.equal(data.items.some((item) => item.name === "b"), true);
});

test("AE 面板按 Hub 的 AE 来源分类外部预设", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.match(lib, /aeCounts/);
  assert.match(lib, /state\.presetCategory\.indexOf\("ae:"\)/);
  assert.match(lib, /AE 预设分类/);
  assert.match(lib, /sidebar-group-title/);
  assert.match(lib, /item\.external/);
  assert.match(css, /\.sidebar-group-title\s*\{/);
});

test("面板只在载入时刷新，不轮询外部文件变化", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const bridge = read("cep/com.dreamengine.panel/js/bridge.js");
  assert.doesNotMatch(lib, /watchStamp|pollWatch|reloadFromDisk|startWatch|WATCH_INTERVAL/);
  assert.doesNotMatch(lib, /if \(view === "presets"\) loadPresetLibrary/);
  assert.match(lib, /function loadPresetLibrary\(done, skipRender\)/);
  assert.doesNotMatch(bridge, /watchStamp/);
});

test("卡片悬停延迟播放，滚轮时暂停预览并保留轻量 3D 倾斜", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const html = read("cep/com.dreamengine.panel/index.html");
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.match(lib, /document\.addEventListener\("wheel", suppressPreviewPlayback/);
  assert.match(lib, /setTimeout\(function \(\) \{[\s\S]*?play\(\);[\s\S]*?\}, 220\)/);
  assert.match(html, /card_tilt\.js/);
  assert.match(css, /perspective\(900px\)/);
  assert.match(css, /rotateX\(var\(--tilt-x\)\)/);
  assert.doesNotMatch(css, /filter:\s*brightness\(1\.08\)/);
  assert.doesNotMatch(css, /card-stars|星点/);
});

test("长卡片列表使用离屏懒挂载", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.match(lib, /function renderLazyCards\(/);
  assert.match(lib, /IntersectionObserver/);
  assert.match(css, /\.card-slot\s*\{/);
});

test("应用预设的安全措施一个都不能少", () => {
  const src = read("cep/com.dreamengine.panel/engine/presets.jsx");
  // 注释里会提到这些被禁用的写法（例如说明「不要用 app.applyPreset」），
  // 所以断言只看代码行。
  const code = codeOf(src);
  // 选层用 layer.selected，不能给 comp.selectedLayers 赋值（AE 2021 上会崩 AE）
  assert.match(code, /target\.selected = true/);
  assert.doesNotMatch(code, /comp\.selectedLayers = \[/);
  // 用图层方法应用预设，不能用 app.applyPreset（AE 2021 上会崩 AE）
  assert.match(code, /best\.layer\.applyPreset\(file\)/);
  assert.doesNotMatch(code, /app\.applyPreset\(/);
  // 试探要能回滚：只保留效果最多的那一层
  assert.match(code, /function rollback\(/);
  assert.match(code, /rollback\(comp, target, before, after\)/);
  // 按类型顺序重试：纯色 → 文本 → 素材 → 调整层
  assert.match(src, /LAYER_ORDER = \["solid", "text", "footage", "adjustment"\]/);
  // 调用后要比对效果数与关键帧数，才知道有没有真的生效
  assert.match(code, /addedEffects/);
  assert.match(code, /addedKeys/);
  // 自动新建的图层用 remove() 删掉（不依赖撤销）
  assert.match(code, /comp\.layer\(i\)\.remove\(\)/);
  // 没有选中层时预设会自己建层，所以必须先记录调用前的图层数
  assert.match(code, /before = snapshot\(comp\)/);
});

test("不能依赖 AE 的几个不稳定 API", () => {
  const src = read("cep/com.dreamengine.panel/engine/presets.jsx");
  const code = codeOf(src);
  // app.path 在 AE 2021 是 undefined（所以预设目录靠扫 Program Files 找到，
  // app.path 只能当兜底）；typeName 是本地化的；getItemByName 会崩 AE
  assert.match(code, /Support Files\/Presets/);
  assert.doesNotMatch(code, /typeName\) === "Composition"/);
  assert.doesNotMatch(code, /items\.getItemByName/);
  // 合成判定改成看有没有 numLayers
  assert.match(code, /item\.numLayers/);
  // 目录名可能是 URL 编码形式，比较时要能解码
  assert.match(code, /decodeURI/);
});

test("预设目录扫描必须递归（单层 getFiles('*.ffx') 在 AE 上返回 0）", () => {
  const src = read("cep/com.dreamengine.panel/engine/presets.jsx");
  assert.match(src, /entry instanceof Folder/);
  assert.match(src, /collect\(entry, depth \+ 1, out\)/);
});

test("依赖检查用 catalog 的 hasEffect，不重新解析整份 JSON", () => {
  const presets = read("cep/com.dreamengine.panel/engine/presets.jsx");
  const code = codeOf(presets);
  assert.match(presets, /AEV_Catalog\.hasEffect/);
  assert.doesNotMatch(code, /eval\([^)]*(catalog|dependencies)/i);
});

test("catalog 的会话缓存：只枚举一次 app.effects", () => {
  let enumerations = 0;
  const ctx = vm.createContext({
    app: {
      version: "18.4.1",
      get effects() {
        enumerations++;
        return [
          { matchName: "ADBE Glo2", displayName: "发光", category: "风格化" },
          { matchName: "BCC Glow", displayName: "BCC Glow", category: "BCC Lights" }
        ];
      }
    },
    PropertyValueType: { COLOR: 6419, CHECKBOX: 6414, OneD: 6417, TWO_D: 6418 }
  });
  vm.runInContext(read("cep/com.dreamengine.panel/engine/catalog.jsx"), ctx);
  const catalog = ctx.AEV_Catalog;
  const first = catalog.getCatalogJson(false);
  const second = catalog.getCatalogJson(false);
  assert.equal(first, second, "两次取值应完全一致");
  assert.equal(enumerations, 1, "app.effects 只应枚举一次（缓存生效）");
  assert.equal(catalog.hasEffect("ADBE Glo2"), true);
  assert.equal(catalog.hasEffect("S_Glow"), false);
  const forced = catalog.getCatalogJson(true);
  assert.equal(forced, first, "同样的数据，JSON 应一致");
  assert.equal(enumerations, 2, "force=true 应重新枚举");
});

test("引擎模块列表包含 presets（面板要能调到它）", () => {
  const bridge = read("cep/com.dreamengine.panel/js/bridge.js");
  assert.match(bridge, /engine\/presets\.jsx/);
  // catalog 必须在 presets 之前：presets 的依赖检查要用 catalog.hasEffect
  const catalogAt = bridge.indexOf("engine/catalog.jsx");
  const presetsAt = bridge.indexOf("engine/presets.jsx");
  assert.ok(catalogAt > 0 && presetsAt > catalogAt, "加载顺序：catalog 先于 presets");
});

test("选择外部 AE 预设时不被空的用户预设库拦截", () => {
  const ps1 = read("tools/generate_plugin_presets.ps1");
  assert.match(
    ps1,
    /if \(-not \(Test-Path \$presets\) -and -not \$PresetList -and -not \$OnlyPreset\)/,
  );
});

test("单独渲染外部 AE 预设时只取指定路径，Force 不会被旧账本挡住", () => {
  const ps1 = read("tools/generate_plugin_presets.ps1");
  assert.match(ps1, /\$all = if \(\$OnlyPreset\) \{ @\(\$OnlyPreset\) \}/);
  assert.match(ps1, /-not \$Force -and \$complete\.ContainsKey\(\$OnlyPreset\)/);
});
test("AE 只读取预设库，添加预设由 Hub 负责", () => {
  const src = read("cep/com.dreamengine.panel/engine/presets.jsx");
  const code = codeOf(src);
  assert.match(code, /function libraryJson\(/);
  assert.doesNotMatch(code, /function pickJson\(/);
  assert.doesNotMatch(code, /File\.openDialog\(/);
  assert.doesNotMatch(code, /function importOneJson\(/);
  assert.doesNotMatch(code, /src\.copy\(target\)/);
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  assert.doesNotMatch(lib, /scanJson\(/);
  assert.doesNotMatch(lib, /defaultRootJson\(/);
  assert.match(lib, /AEV_Presets\.libraryJson\(\)/);
  assert.doesNotMatch(lib, /AEV_Presets\.pickJson\(\)/);
  assert.doesNotMatch(lib, /AEV_Presets\.importOneJson\(/);
});

test("预设页右上角可通过 AE 启动 DreamEngine Hub", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const bridge = read("cep/com.dreamengine.panel/js/bridge.js");
  const hub = read("hub/main.js");
  const nsis = read("hub/build/installer.nsh");

  assert.match(html, /id="btnOpenHub"/);
  assert.match(lib, /Bridge\.openHub\(/);
  assert.match(bridge, /hub-path\.txt/);
  assert.match(bridge, /Start Menu\/Programs\/DreamEngine Hub\.lnk/);
  assert.match(bridge, /hub\/dist\/win-unpacked\/DreamEngine Hub\.exe/);
  assert.match(bridge, /file\.execute\(\)/);
  assert.match(hub, /rememberHubPath\(paths\)/);
  assert.match(nsis, /hub-path\.txt/);

  // 真正跑一遍 Bridge 生成的 ExtendScript：路径标记应被读取并执行。
  let jsx = "";
  const browser = vm.createContext({
    window: {
      __adobe_cep__: {
        evalScript(source, callback) {
          jsx = source;
          callback("captured");
        },
      },
    },
  });
  vm.runInContext(bridge, browser);
  browser.Bridge.openHub(() => {});

  const launched = [];
  function FileMock(path) {
    this.path = String(path);
    this.fsName = String(path);
    this.exists = true;
  }
  FileMock.prototype.open = () => true;
  FileMock.prototype.read = () => "C:/Apps/DreamEngine Hub.exe\r\n";
  FileMock.prototype.close = () => {};
  FileMock.prototype.execute = function execute() {
    launched.push(this.fsName);
    return true;
  };
  function FolderMock(path) {
    this.path = String(path);
    this.fsName = String(path);
  }
  FolderMock.prototype.getFiles = () => [];
  FolderMock.myDocuments = { fsName: "C:/Users/test/Documents" };
  FolderMock.userData = { fsName: "C:/Users/test/AppData/Roaming" };
  FolderMock.desktop = { fsName: "C:/Users/test/Desktop" };

  const extendScript = vm.createContext({
    File: FileMock,
    Folder: FolderMock,
    $: { getenv: () => "" },
  });
  const result = vm.runInContext(jsx, extendScript);
  assert.match(result, /^OK:C:\/Apps\/DreamEngine Hub\.exe$/);
  assert.deepEqual(launched, ["C:/Apps/DreamEngine Hub.exe"]);
});

test("AE 面板没有添加预设入口、拖放入库和底部提示", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const code = codeOf(lib);
  assert.doesNotMatch(html, /id="btnPresetAdd"/);
  assert.doesNotMatch(html, /id="presetFileInput"/);
  assert.doesNotMatch(html, /id="presetHint"/);
  assert.doesNotMatch(html, /id="presetSummary"/);
  assert.doesNotMatch(code, /function addPresets\(/);
  assert.doesNotMatch(code, /function importPresetPaths\(/);
  assert.doesNotMatch(code, /function onPresetDrop\(/);
  assert.doesNotMatch(code, /addEventListener\("drop", onPresetDrop\)/);
});

test("AE 预设长按删除只允许操作预设库内的 .ffx", () => {
  const root = "C:/Docs/DreamEngine/presets";
  const files = new Set([
    "c:/docs/dreamengine/presets/inside.ffx",
    "c:/docs/outside.ffx",
    "c:/docs/dreamengine/presets/notes.txt"
  ]);
  const removed = [];
  class FileMock {
    constructor(path) {
      this.fsName = String(path || "").replace(/\\/g, "/");
      this.name = this.fsName.split("/").pop();
      this.exists = files.has(this.fsName.toLowerCase());
    }
    remove() {
      this.exists = false;
      removed.push(this.fsName);
      return true;
    }
  }
  const ctx = vm.createContext({
    File: FileMock,
    Folder: function Folder(path) { this.fsName = String(path || ""); },
    AEV_Store: {
      folderAt() {
        return { exists: true, fsName: root, create() { return true; } };
      }
    }
  });
  vm.runInContext(read("cep/com.dreamengine.panel/engine/presets.jsx"), ctx);
  const p = ctx.AEV_Presets;
  assert.equal(JSON.parse(p.deleteJson("C:\\Docs\\DreamEngine\\presets\\inside.ffx")).status, "ok");
  assert.deepEqual(removed, ["C:/Docs/DreamEngine/presets/inside.ffx"]);
  assert.match(p.deleteJson("C:/Docs/outside.ffx"), /"reason":"outside_library"/);
  assert.match(p.deleteJson("C:/Docs/DreamEngine/presets/notes.txt"), /"reason":"not_ffx"/);

  const html = read("cep/com.dreamengine.panel/index.html");
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.match(html, /id="presetDeleteDialog"/);
  assert.match(html, /id="presetDeleteConfirm"/);
  assert.match(lib, /function startPresetHold\(/);
  assert.match(lib, /setTimeout\(function \(\) \{[\s\S]*?\}, 650\)/);
  assert.match(lib, /AEV_Presets\.deleteJson\(/);
  assert.match(css, /\.preset-delete-dialog\s*\{[^}]*position:\s*fixed/s);
});

test("预设单击或双击只应用一次", () => {
  const lib = codeOf(read("cep/com.dreamengine.panel/js/library.js"));
  assert.match(lib, /if \(event\.detail > 1\)/);
  assert.match(lib, /event\.preventDefault\(\);/);
});

/* ---------- 预设预览生成（静态 / 关键帧区间 / 用户背景） ---------- */

test("AE 面板不再加载或调用预设预览生成引擎", () => {
  const bridge = read("cep/com.dreamengine.panel/js/bridge.js");
  assert.doesNotMatch(bridge, /engine\/preset_preview\.jsx/);
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  assert.doesNotMatch(lib, /AEV_PresetPreview\.renderJson\(/);
  assert.doesNotMatch(lib, /AEV_PresetPreview\.backgroundsJson\(/);
});

test("预设帧率上限按用户选择的 fps 与 6 秒区间计算", () => {
  const ctx = vm.createContext({});
  vm.runInContext(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"), ctx);
  assert.equal(ctx.AEV_PresetPreview.frameLimit(12), 72);
  assert.equal(ctx.AEV_PresetPreview.frameLimit(24), 144);
  assert.equal(ctx.AEV_PresetPreview.frameLimit(30), 180);
  assert.equal(ctx.AEV_PresetPreview.frameLimit(60), 360);
});

test("静态预设出 1 帧；动态预设按所选 fps 渲染并保留真实时长", () => {
  const src = codeOf(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"));
  // 关键帧范围靠遍历属性树读 numKeys / keyTime，不读参数值（读值会崩 AE）
  assert.match(src, /function walkKeys\(/);
  assert.match(src, /p\.numKeys/);
  assert.match(src, /p\.keyTime\(1\)/);
  assert.doesNotMatch(src, /\.maxValue/);
  // 无关键帧 → 静态 1 帧
  assert.match(src, /var keyAnimated = range\.keys > 0/);
  assert.match(src, /var span = 1 \/ fps/);
  assert.match(src, /var DEFAULT_FPS = 24/);
  assert.match(src, /var fps = Math\.max\(1, Number\(opts\.fps\) \|\| DEFAULT_FPS\)/);
  // 有关键帧 → 渲染整个区间（timeSpanStart / Duration），最多保留 6 秒对应帧数
  assert.match(src, /queueItem\.timeSpanStart = renderStart/);
  assert.match(src, /queueItem\.timeSpanDuration = span/);
  assert.match(src, /Math\.min\(frameLimit\(fps\), rawFiles\.length\)/);
  assert.match(src, /var wanted = animated \?/);
  assert.match(src, /\["duration", String\(Math\.round\(span \* 1000\) \/ 1000\)\]/);
  assert.match(src, /\["fps", String\(fps\)\]/);
  // comp 时长必须覆盖到最后一个关键帧
  assert.match(src, /comp\.duration = Math\.max/);
  // 模板队列第一次渲染偶尔返回 no_frames；必须重建队列项重试一次
  assert.match(src, /no_frames/);
  assert.match(src, /retried/);
  assert.match(src, /clearKeptFrames\(\)/);
  assert.match(src, /targetQueueItem\.duplicate\(\)/);


  const lib = codeOf(read("cep/com.dreamengine.panel/js/library.js"));
  assert.match(lib, /var durationSeconds = Number\(preview\.duration\) \|\| 0/);
  assert.match(lib, /var frameDelay = durationSeconds > 0/);
  assert.match(lib, /\}, frameDelay\)/);

  const runner = read("tools/run_plugin_preset_preview.jsx");
  const ps = read("tools/generate_plugin_presets.ps1");
  const nodeDriver = read("tools/run_plugin_preset_batches.mjs");
  assert.match(runner, /ENTRY_HEADER = .*duration\\tfps/);
  assert.match(runner, /String\(data\.duration \|\| 0\)/);
  assert.match(runner, /cellSize\\tfolder/);
  assert.match(runner, /folder: presetFolder/);
  assert.match(ps, /previews\/presets\/.*presetFolder/);
  assert.match(runner, /String\(data\.fps \|\| 0\)/);
  assert.match(runner, /done\[ep\[1\]\] = true/);
  assert.match(ps, /duration = \$duration/);
  assert.match(ps, /fps = \$fps/);
  assert.match(ps, /\$byPath = @\{\}/);
  assert.match(ps, /\$done\[\$r\[1\]\] = \$true/);
  assert.match(nodeDriver, /duration > 0 && fps >= 6/);
  assert.match(nodeDriver, /const byPath = new Map\(\)/);
});
test("文字预设按 1920x1080 舞台应用后重新居中，并识别表达式预设", () => {
  const src = codeOf(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"));
  // AE 自带文字预设按 1920x1080 画布设计；直接落到 360/720 方画布会把路径和位移动出画面。
  assert.match(src, /var TEXT_STAGE_WIDTH = 1920/);
  assert.match(src, /var TEXT_STAGE_HEIGHT = 1080/);
  assert.match(src, /function recenterTextLayer\(/);
  assert.match(src, /recenterTextLayer\(/);
  assert.match(src, /size \/ TEXT_STAGE_HEIGHT \* 100/);
  // applyPreset 会替换示例文字；必须在应用后按最终文本重新测边界，不能只按应用前居中。
  assert.match(src, /sourceRectAtTime/);
  // 三个 Expressions 预设只写表达式，不新增效果/关键帧/动画器；快照必须单独统计表达式。
  assert.match(src, /expressionEnabled/);
  assert.match(src, /after\.expressions > before\.expressions/);
  assert.match(src, /var EXPRESSION_SPAN_SECONDS = 3/);
  assert.match(src, /var animated = keyAnimated \|\| expressionAnimated/);
  // 非 Text 分类需要按类别换舞台，不能全部套文字或单图层。
  assert.match(src, /function presetCategory/);
  assert.match(src, /function addShapeStage/);
  assert.match(src, /function addTransitionStage/);
  assert.match(src, /function addCreativeStage/);
  assert.match(src, /lower === "image - creative"/);
  assert.match(src, /function addWaveformStage/);
  assert.match(src, /stageKind === "audio"/);
  assert.match(src, /expressionCount > 0/);
});

test("转场和 Image 舞台使用默认渲染图，转场先创建双图层再落前景", () => {
  const src = codeOf(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"));
  assert.match(src, /function defaultPhotoPath\(/);
  assert.match(src, /AEV_Assets\.getFresh\("photo", TEXT_STAGE_HEIGHT, defaultPhotoPath\(extensionPath\)\)/);
  assert.match(src, /addTransitionStage\(comp, size, trash, fps, sheetIndex, extensionPath\)/);
  assert.match(src, /addCreativeStage\(comp, size, trash, fps, sheetIndex, extensionPath\)/);
  assert.match(src, /targets: \[\{ comp: stage, layer: top \}\]/);
});

test("安装包内置预设使用 bundled WebP 帧序列并合并索引", () => {
  assert.match(read("hub/core/paths.js"), /bundledPresetManifest/);
  assert.match(read("hub/core/presets.js"), /readIndex\(paths\.bundledPresetManifest\)/);
  assert.match(read("cep/com.dreamengine.panel/js/library.js"), /data\/bundled_preset_manifest\.json/);
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  const presetIndexStart = lib.indexOf("function loadPresetIndex");
  const presetIndexEnd = lib.indexOf("function hasPresetPreview", presetIndexStart);
  assert.ok(presetIndexStart >= 0 && presetIndexEnd > presetIndexStart);
  const presetIndexBlock = lib.slice(presetIndexStart, presetIndexEnd);
  assert.ok(presetIndexBlock.indexOf("data/preset_plugin_manifest.json") < presetIndexBlock.indexOf("data/bundled_preset_manifest.json"));
  assert.ok(presetIndexBlock.indexOf("data/bundled_preset_manifest.json") < presetIndexBlock.indexOf("data/preset_manifest.json"));
  assert.match(read("tools/prepare_hub_bundle.mjs"), /PRESET_SRC/);
  assert.match(read("tools/install_dreamengine.ps1"), /bundled_preset_manifest\.json/);
  assert.match(read("tools/package_preset_previews.mjs"), /format: "webp-frame-sequence"/);
  assert.match(read("tools/package_preset_previews.mjs"), /\.\(png\|webp\)/);
});
test("预设卡片静态图选内容最多的一帧，不再固定取中间帧", () => {
  const ps = read("tools/generate_plugin_presets.ps1");
  const nodeDriver = read("tools/run_plugin_preset_batches.mjs");
  assert.match(ps, /function Get-BestStillFrame/);
  assert.match(ps, /stillFrame = Get-BestStillFrame/);
  assert.match(nodeDriver, /function bestStillFrame/);
  assert.match(nodeDriver, /stillSrc:/);
});
test("预设渲染可选 PNG 序列 / WebP 动画文件，效果预览固定单文件动画", () => {
  const html = read("hub/renderer/index.html");
  const flow = read("hub/renderer/flow.js");
  const builder = read("hub/core/effect_preview_builder.js");
  const merger = read("hub/core/preset_anim_merger.js");
  assert.match(html, /id="flowPresetFormat"/);
  // 选项只剩两种：PNG 序列 / WebP 动画文件（旧「WebP 序列」已废弃）
  assert.match(html, /<option value="png"[^>]*>PNG 序列<\/option>/);
  assert.match(html, /<option value="animated"[^>]*>WebP 动画文件<\/option>/);
  assert.doesNotMatch(html, /<option value="webp">/);
  assert.match(flow, /presetFormat/);
  assert.match(flow, /mergePresetAnimation/);
  // 效果侧产出单文件动画：有 webpSrc，没有 frameSrc
  assert.match(builder, /format = "webp-animated"/);
  assert.match(builder, /item\.webpSrc = previewPaths\.logicalValue\("effects", `webp\/\$\{pluginName\}\/anim\//);
  assert.doesNotMatch(builder, /format = "webp-sequence"/);
  // 预设侧的合并器同样产出 webpSrc
  assert.match(merger, /webpSrc = animLogical/);
  assert.match(merger, /format = "webp-animated"/);
});

test("离线预设运行器从 FPS 文件读取帧率并传给 renderJson", () => {
  const runner = read("tools/run_plugin_preset_preview.jsx");
  const ps = read("tools/generate_plugin_presets.ps1");
  assert.match(runner, /preset_plugin_fps\.txt/);
  assert.match(runner, /fps:\s*renderFps/);
  assert.match(runner, /cellSize:\s*previewCellSize/);
  assert.match(ps, /\[ValidateSet\(12,\s*24,\s*30,\s*60\)\]/);
  assert.match(ps, /\[int\]\$Fps\s*=\s*24/);
  assert.match(ps, /preset_plugin_fps\.txt/);
  assert.match(ps, /\[ValidateSet\(360,\s*720\)\]/);
  assert.match(ps, /sliceCellSize = \$entryCellSize/);
});

test("Hub 确认页只为 AE 预设显示 12/24/30/60fps 并传入渲染任务", () => {
  const html = read("hub/renderer/index.html");
  const flow = read("hub/renderer/flow.js");
  assert.match(html, /id="flowPresetFps"/);
  for (const fps of [12, 24, 30, 60]) {
    assert.match(html, new RegExp(`<option value="${fps}"`));
  }
  assert.match(flow, /presetFps:\s*24/);
  assert.match(flow, /\[12, 24, 30, 60\]\.includes\(value\)/);
  assert.match(flow, /show\("flowPresetFpsField", kind === "preset"\)/);
  assert.match(flow, /fps:\s*Math\.max\(12,/);
});

test("渲染在临时合成里做，插件预设跳过，临时对象全部回收", () => {
  const src = codeOf(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"));
  assert.match(src, /app\.project\.items\.addComp\(\s*"DE_preset_cell_/);
  // AE 2021 上会崩的写法一个都不能用
  assert.doesNotMatch(src, /app\.applyPreset\(/);
  assert.doesNotMatch(src, /comp\.selectedLayers\s*=/);
  assert.doesNotMatch(src, /getItemByName/);
  assert.match(src, /\.layer\.applyPreset\(file\)/);
  // 含第三方插件效果的预设不渲染
  assert.match(src, /function pluginMatchNames\(/);
  assert.match(src, /result\("plugin_preset"/);
  // 渲染队列项 / 临时合成 / 素材 / raw 帧都要删
  assert.match(src, /queueItem\.remove\(\)/);
  assert.match(src, /comp\.remove\(\)/);
  assert.match(src, /rawFiles\[i\]\.remove\(\)/);
});

test("插件预设复用随包 AEP 的 PNG 渲染队列，不依赖系统输出模板", () => {
  const src = codeOf(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"));
  const runner = read("tools/run_plugin_preset_preview.jsx");
  const scheduler = read("tools/generate_plugin_presets.ps1");

  assert.match(src, /opts\.targetComp/);
  assert.match(src, /opts\.targetQueueItem/);
  assert.match(src, /opts\.targetQueueItem\.duplicate\(\)/);
  assert.match(src, /queueItem\.render = true/);
  assert.ok(
    src.indexOf("queueItem.render = true") < src.indexOf("outputModule.file ="),
    "复用已完成的模板队列时，必须先 requeue 再写输出路径",
  );
  assert.match(runner, /preset_render_template_path\.txt/);
  assert.match(runner, /function openRenderTemplate/);
  assert.match(runner, /targetComp: renderTemplateComp/);
  assert.match(runner, /targetQueueItem: renderTemplateQueue/);
  assert.match(scheduler, /DreamEnginePNG\.aep/);
});

test("预设只作用在背景对应的目标图层，不再自动垫文字层", () => {
  const src = codeOf(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"));
  assert.match(src, /function applyToTargets\(/);
  assert.match(src, /layer instanceof TextLayer/);
  assert.match(src, /kind === "solid" \? "base" : "body"/);
  assert.match(src, /walkLayerTree\(/);
  assert.doesNotMatch(src, /comp\.layers\.addText\("PRESET"\)/);
});

test("文字预览素材按文字实际边界居中，左右和上下都不出画", () => {
  class ValueProp {
    constructor(value) {
      this.value = value;
    }
    setValue(value) {
      this.value = value;
    }
  }

  class Layer {
    constructor(name, kind) {
      this.name = name;
      this.kind = kind;
      this.transform = {
        position: new ValueProp([0, 0]),
        scale: new ValueProp([100, 100]),
        anchor: new ValueProp([0, 0]),
      };
      this.doc = {
        text: name === "Dream" ? "Dream" : name === "Engine" ? "Engine" : "AE",
        fontSize: 0,
        fillColor: [],
        justification: 7413,
        baselineShift: 54,
        boxText: false,
      };
    }
    property(name) {
      if (name === "ADBE Transform Group") {
        return {
          property: (child) => {
            if (child === "ADBE Position") return this.transform.position;
            if (child === "ADBE Scale") return this.transform.scale;
            if (child === "ADBE Anchor Point") return this.transform.anchor;
            throw new Error("unknown transform property " + child);
          },
        };
      }
      if (name === "ADBE Text Properties") {
        const doc = new ValueProp(this.doc);
        return {
          property: (child) => {
            if (child !== "ADBE Text Document") throw new Error("unknown text property " + child);
            Object.defineProperty(doc, "value", {
              get: () => this.doc,
              set: (value) => { this.doc = value; },
            });
            return doc;
          },
        };
      }
      throw new Error("unknown layer property " + name);
    }
    sourceRectAtTime() {
      return { left: 0.4, top: -88, width: 82, height: 67 };
    }
    moveToEnd() {}
  }
  class TextLayerMock extends Layer {}

  class Comp {
    constructor() {
      this.created = [];
      this.layers = {
        addSolid: (_color, name) => {
          const layer = new Layer(name, "solid");
          this.created.push(layer);
          return layer;
        },
        addText: (text) => {
          const layer = new TextLayerMock(text, "text");
          this.created.push(layer);
          return layer;
        },
      };
    }
    get numLayers() {
      return this.created.length;
    }
    layer(index) {
      return this.created[index - 1];
    }
  }

  const ctx = vm.createContext({
    ParagraphJustification: { CENTER_JUSTIFY: 7415 },
    TextLayer: TextLayerMock,
    app: {
      project: {
        items: {
          addComp: () => new Comp(),
        },
      },
    },
  });
  vm.runInContext(read("cep/com.dreamengine.panel/engine/assets.jsx"), ctx);
  const asset = ctx.AEV_Assets.getFresh("text", 128);
  const textLayers = asset.created.filter((layer) => layer.kind === "text");
  assert.equal(textLayers.length, 1, "文字预览素材必须只有一个文字图层");
  const textLayer = textLayers[0];
  const nested = new Layer("text asset", "asset");
  nested.transform.anchor.value = [64, 64];
  ctx.AEV_Assets.centerTextAsset(asset, nested, 128);

  // 必须在文字进入父级预合成之前，把文字图层本身移进 128×128 边界。
  // 只移动 nested 会让文字先在 DE_asset_text 内被裁掉，右侧无法恢复。
  assert.deepEqual(
    Array.from(textLayer.transform.position.value, (value) => Number(value.toFixed(3))),
    [22.6, 118.5],
  );
  assert.deepEqual(
    Array.from(nested.transform.position.value, (value) => Number(value.toFixed(3))),
    [64, 64],
  );

  function visibleBounds(layer) {
    const rect = layer.sourceRectAtTime(0, false);
    const position = layer.transform.position.value;
    const anchor = layer.transform.anchor.value;
    const nestedPosition = nested.transform.position.value;
    const nestedAnchor = nested.transform.anchor.value;
    return {
      left: position[0] + rect.left - anchor[0] + nestedPosition[0] - nestedAnchor[0],
      right: position[0] + rect.left + rect.width - anchor[0] + nestedPosition[0] - nestedAnchor[0],
      top: position[1] + rect.top - anchor[1] + nestedPosition[1] - nestedAnchor[1],
      bottom: position[1] + rect.top + rect.height - anchor[1] + nestedPosition[1] - nestedAnchor[1],
    };
  }
  for (const layer of textLayers) {
    const bounds = visibleBounds(layer);
    assert.ok(bounds.left >= 0 && bounds.right <= 128, JSON.stringify(bounds));
    assert.ok(bounds.top >= 0 && bounds.bottom <= 128, JSON.stringify(bounds));
  }
});

test("预览背景不再提供条纹，保留其余内置项和用户上传", () => {
  const src = codeOf(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"));
  const backgroundsStart = src.indexOf("BUILTIN_BACKGROUNDS = [");
  const backgroundsEnd = src.indexOf("function config()", backgroundsStart);
  const backgrounds = src.slice(backgroundsStart, backgroundsEnd);
  assert.match(src, /BUILTIN_BACKGROUNDS = \[/);
  assert.match(src, /"photo"/);
  assert.match(src, /"text"/);
  assert.match(src, /"solid"/);
  assert.match(src, /"shape"/);
  assert.doesNotMatch(backgrounds, /"pattern"/);
  assert.doesNotMatch(backgrounds, /条纹/);
  const hubMain = codeOf(read("hub/main.js"));
  const hubStart = hubMain.indexOf('ipcMain.handle("backgrounds:list"');
  const hubEnd = hubMain.indexOf('ipcMain.handle("backgrounds:add"', hubStart);
  assert.doesNotMatch(hubMain.slice(hubStart, hubEnd), /id:\s*"pattern"|条纹/);
  assert.match(src, /function importBackgroundJson\(/);
  assert.match(src, /function addBackground\(/);
  assert.match(src, /AEV_Assets\.getFresh\(id, size, resolvedBackground\)/);
  // 独立索引，绝不写 L1 的 manifest.json
  assert.match(src, /preset_manifest\.json/);
  assert.doesNotMatch(src, /data\/manifest\.json/);
});

test("AE 不再提供预览背景和生成入口，卡片仍区分静态与动态", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const lib = codeOf(read("cep/com.dreamengine.panel/js/library.js"));
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.doesNotMatch(html, /id="presetBackground"/);
  assert.doesNotMatch(html, /id="btnBackgroundAdd"/);
  assert.doesNotMatch(html, /id="btnPresetPreview"/);
  assert.doesNotMatch(html, /id="presetBackgroundFile"/);
  assert.doesNotMatch(lib, /function generatePresetPreviews\(/);
  assert.doesNotMatch(lib, /function loadBackgrounds\(/);
  assert.doesNotMatch(lib, /function savePresetIndex\(/);
  assert.match(lib, /function loadPresetIndex\(/);
  assert.match(lib, /function attachPreview\(/);
  assert.match(lib, /preview\.animated !== false/);
  assert.match(css, /\.preset-thumb\s*\{/);
  assert.match(css, /\.preset-badge/);
});

test("AE 面板预设预览按路径匹配，并在重新激活时刷新 Hub 索引", () => {
  const lib = codeOf(read("cep/com.dreamengine.panel/js/library.js"));
  assert.match(lib, /presetPreviewsByPath/);
  assert.match(lib, /function previewForPreset\(item\)/);
  assert.match(lib, /AEV_Prefs\.pathKey\(item && item\.path\)/);
  assert.match(lib, /function refreshPresetPreviews\(/);
  assert.match(lib, /window\.addEventListener\("focus", refreshPresetPreviews\)/);
  assert.match(lib, /document\.addEventListener\("visibilitychange"/);
});

test("AE 面板预览 URL 会编码中文目录和空格", () => {
  const lib = codeOf(read("cep/com.dreamengine.panel/js/library.js"));
  assert.match(lib, /function dataUrl\(relative\)/);
  assert.match(lib, /split\("\/"\)\.map\(encodeURIComponent\)\.join\("\/"\)/);
  assert.match(lib, /var stillUrl = preview\.stillSrc \? dataUrl/);
  assert.match(lib, /animated\.src = dataUrl\(preview\.webpSrc\)/);
  assert.match(lib, /var webpSequence = preview\.format === "webp-sequence"/);
  assert.match(lib, /thumb\.style\.backgroundSize = "cover"/);
  assert.match(lib, /return dataUrl\(String\(template\)\.replace\("%04d"/);
});

test("AE 2021 CEP 使用 padding 回退正方形缩略图高度", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  const thumb = css.slice(
    css.indexOf("\n.thumb {"),
    css.indexOf("\n.thumb .preview-webp"),
  );
  const preset = css.slice(
    css.indexOf("\n.preset-thumb {"),
    css.indexOf("\n.preset-thumb .thumb-placeholder"),
  );
  assert.match(thumb, /height:\s*0;/);
  assert.match(thumb, /padding-top:\s*100%;/);
  assert.match(preset, /height:\s*0;/);
  assert.match(preset, /padding-top:\s*100%;/);
});

test("AE 2021 CEP 网格提供无 min() 的卡片尺寸回退", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.match(
    css,
    /grid-template-columns:\s*repeat\(auto-fill,\s*var\(--view-size,\s*132px\)\);/,
  );
  assert.match(
    css,
    /grid-template-columns:\s*repeat\(auto-fill,\s*var\(--view-size,\s*180px\)\);/,
  );
});

test("AE 2021 CEP 滑块直接写入像素列宽", () => {
  const lib = codeOf(read("cep/com.dreamengine.panel/js/library.js"));
  assert.match(
    lib,
    /grid\.style\.gridTemplateColumns = "repeat\(auto-fill, " \+ value \+ "px\)"/,
  );
});

test("AE 2021 CEP 卡片悬停提供无变量 scale 回退", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  const hover = css.slice(
    css.indexOf(".effect-card:hover,"),
    css.indexOf("/* 白框"),
  );
  assert.match(hover, /transform:\s*scale\(1\.05\);/);
});

/* ---------- 含第三方插件的预设：离线专用通道 ---------- */

test("引擎有 allowPlugins 开关：面板默认跳过，离线实例放行", () => {
  const src = codeOf(read("cep/com.dreamengine.panel/engine/preset_preview.jsx"));
  assert.match(src, /var allowPlugins = !!opts\.allowPlugins/);
  assert.match(src, /if \(plugins\.length > 0 && !allowPlugins\)/);
  assert.match(src, /result\("plugin_preset"/);
  // 结果里要把插件名单带出来，索引才能标「离线生成」
  assert.match(src, /\["plugins", plugins\.join\(","\)\]/);
});

test("离线脚本逐条隔离、心跳与崩溃黑名单一样不少", () => {
  const src = read("tools/run_plugin_preset_preview.jsx");
  assert.match(src, /PS\.parseLog\(/);
  assert.match(src, /PS\.mergeBlacklist\(blacklist, crashed, "crash"\)/);
  assert.match(src, /appendLog\("BEGIN", presetPath/);
  assert.match(src, /appendLog\("OK", presetPath/);
  assert.match(src, /allowPlugins: true/);
  // 每条成功立刻追加 TSV，崩溃不丢已渲结果
  assert.match(src, /appendText\(ENTRIES, rowOut/);
  assert.match(src, /preset_plugin_previews\.tsv/);
  assert.match(src, /preset_plugin_blacklist\.tsv/);
  assert.match(src, /app\.quit\(SaveOptions\.DO_NOT_SAVE_CHANGES\)/);
  assert.match(src, /template_render_\[####\]\.png/);
});

test("批量驱动会拒绝在用户 AE 开着时启动，并跳过已完成/黑名单条目", () => {
  const src = read("tools/run_plugin_preset_batches.mjs");
  assert.match(src, /if \(aeRunning\(\)\) \{[\s\S]*?process\.exit\(1\)/);
  assert.match(src, /!done\.has\(p\) && !black\.has\(p\) && !panelDone\.has\(p\)/);
  assert.match(src, /buildPluginIndex\(\)/);
  assert.match(src, /preset_plugin_manifest\.json/);
  assert.match(src, /taskkill/);
  assert.match(src, /--background/);
});

test("AE 原生报错弹窗会终止当前专用实例、拉黑当前预设并继续下一条", () => {
  const ps1 = read("tools/generate_plugin_presets.ps1");
  const watchdog = read("tools/ae_watchdog.ps1");
  assert.match(watchdog, /EnumWindows/);
  assert.match(watchdog, /#32770/);
  assert.match(watchdog, /Close-AEDialogInfo/);
  assert.match(watchdog, /PNGIO/);
  assert.match(watchdog, /5027/);
  assert.match(ps1, /Get-AEDialogInfo/);
  assert.match(ps1, /Get-UnfinishedBeginPaths/);
  assert.match(ps1, /Fail-PendingPreset/);
  assert.match(ps1, /ae_dialog/);
  assert.match(ps1, /render_error/);
  assert.match(ps1, /继续下一条/);
  assert.match(ps1, /Severity -eq "warning"/);
  assert.match(ps1, /customBackgroundFallbackTried/);
  assert.match(ps1, /自定义背景.*标准背景/);
});

test("面板合并 Hub 生成的离线索引，但不在卡片上标记离线生成", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(lib, /loadOptionalJson\("data\/preset_plugin_manifest\.json"/);
  assert.doesNotMatch(lib, /preview\.plugin/);
});

test("给其他用户的一键工具：零 Node 依赖、温和关开 AE、索引无 BOM", () => {
  const ps1 = read("tools/generate_plugin_presets.ps1");
  assert.match(ps1, /param\(/);
  assert.match(ps1, /Read-Host/);              // 关 AE 前必须让用户确认并保存
  assert.match(ps1, /CloseMainWindow\(\)/);    // 温和关闭，不强制结束
  assert.match(ps1, /Start-Process -FilePath \$AE \| Out-Null/);
  assert.match(ps1, /New-Object System\.Text\.UTF8Encoding\(\$false\)/);
  assert.match(ps1, /ConvertTo-Json/);
  assert.match(ps1, /preset_plugin_manifest\.json/);
  // 代码里不能依赖 Node / Python（注释里提到"不需要"不算）
  const ps1Code = ps1.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(ps1Code, /\bnode\b|\.mjs|python/i);
  const bat = read("tools/生成插件预设预览.bat");
  assert.match(bat, /-File "%PS1%"/);
  assert.match(bat, /%~dp0tools\\generate_plugin_presets\.ps1/); // 分发包里 bat 在根目录
  assert.match(bat, /pause/);
});

test("分发包会把一键工具带上，安装脚本与 README 都有说明", () => {
  const build = read("tools/build_release.mjs");
  assert.match(build, /DreamEngine\/tools/);
  for (const name of [
    "ae_watchdog.ps1",
    "generate_plugin_presets.ps1",
    "生成插件预设预览.bat",
    "run_plugin_preset_preview.jsx",
    "generate_plugin_effects.ps1",
    "run_plugin_preview.jsx",
  ]) {
    assert.ok(build.includes(`"${name}"`), `打包清单缺 ${name}`);
  }
  // 安装脚本已抽成独立源文件：能被 -WhatIf 演练、也能被将来的 exe 安装器复用
  assert.match(build, /install_dreamengine\.ps1/, "打包没引用独立的安装脚本");
  const installer = read("tools/install_dreamengine.ps1");
  assert.match(
    installer,
    /Copy-Item -Path \(Join-Path \$toolsSrc "\*"\)/,
    "安装脚本没有把 tools/ 部署到扩展目录",
  );
  assert.match(build, /生成插件预设预览\.bat/);
  assert.match(build, /不需要 Node/);
});

test("安装脚本：升级不删用户数据，PlayerDebugMode 覆盖所有 CEP 版本", () => {
  const installer = read("tools/install_dreamengine.ps1");

  // ① 升级不得清空用户数据。旧实现是 Remove-Item -Recurse 全删再覆盖，
  //    一次升级会把用户几小时的插件预览渲染结果清零。
  assert.match(installer, /\$KEEP = @\(/, "没有用户数据保护清单");
  for (const name of ["manifest.json", "plugin_manifest.json", "preset_plugin_manifest.json", "thumbs"]) {
    assert.ok(installer.includes(`"${name}"`), `KEEP 清单缺 ${name}`);
  }
  // 整目录删除只允许出现在 -Fresh 路径上，且必须带「输入 YES」二次确认
  const purges = installer.split("Remove-Item -Recurse -Force $Target").length - 1;
  assert.equal(purges, 1, "整目录删除出现了 " + purges + " 次，升级路径可能也在删");
  const purgeAt = installer.indexOf("Remove-Item -Recurse -Force $Target");
  const beforePurge = installer.slice(Math.max(0, purgeAt - 500), purgeAt);
  assert.match(beforePurge, /Read-Host/, "-Fresh 删除前没有二次确认");
  assert.match(beforePurge, /YES/, "-Fresh 删除前没有要求输入 YES");

  // ② AE 读的是「自身 CEP 版本对应」的键，只写 CSXS.11 等于在别的版本上没写
  assert.match(
    installer,
    /foreach \(\$v in @\(9, 10, 11, 12, 13, 14\)\)/,
    "PlayerDebugMode 没有覆盖 CSXS.9~14",
  );

  // ③ 开发机上扩展目录是 Junction，顺着链接递归删会毁掉仓库
  assert.match(installer, /ReparsePoint/, "没有 Junction / 符号链接检测");

  // ④ 「是否老用户」必须在复制扩展本体之前判断：复制会在目标里创建
  //    data/manifest.json（包里带了索引时），之后再判断会把全新安装误判成
  //    老用户、跳过 L1 部署 —— 表现为装完一张缩略图都没有。
  const hadIdx = installer.indexOf("$hadLocalManifest = Test-Path");
  const copyIdx = installer.indexOf('Copy-Item -Path (Join-Path $extSrc "*")');
  assert.ok(hadIdx > 0, "没有在复制前记录 $hadLocalManifest");
  assert.ok(copyIdx > 0, "找不到复制扩展本体的语句");
  assert.ok(hadIdx < copyIdx, "$hadLocalManifest 的判断晚于复制扩展本体");
  assert.match(
    installer,
    /if \(\$hadLocalManifest -and -not \$UpdateL1\)/,
    "L1 部署仍在用「当前文件是否存在」判断，会误判全新安装",
  );
});

/* ---------- 运行 ---------- */

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log("[PASS] " + t.name);
  } catch (e) {
    failed++;
    console.log("[FAIL] " + t.name);
    console.log("       " + String(e.message || e).split("\n").slice(0, 6).join("\n       "));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
