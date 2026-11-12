#!/usr/bin/env node
/* ============================================================
 * engine 层测试
 *
 * 覆盖范围：
 *   · render_config 与仓库根 config/render_params.jsxinc 的数值一致性（防漂移）
 *   · recipe 的启发式取值与 no-preview 判定（纯函数，可在 node 内实跑）
 *   · previewgen 的容量规划与失败策略（源码契约 + 纯函数）
 *   · store 的写权限自检必须走 app.preferences，不得再用不存在的 app.settings
 *   · bridge 的 engine 加载顺序（依赖必须先于依赖方）
 *   · queue 的状态机与持久化格式
 *
 * 这些都不是"跑一遍看有没有报错"，而是把 M0 的实测结论与设计约束固化成断言。
 * ============================================================ */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const ENGINE = "cep/com.dreamengine.panel/engine";

function read(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), "utf8");
}

/** 剥掉注释后再做"代码里不得出现 X"类断言。
 *  否则注释里提到 copyToComp / app.settings 这类词会造成误报。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** 在同一 context 内按顺序求值多个 ES3 模块，返回该 context */
function loadModules(relativePaths, extra) {
  const context = vm.createContext(Object.assign({}, extra || {}));
  for (const rel of relativePaths) {
    vm.runInContext(read(rel), context, { filename: rel });
  }
  return context;
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

/* ---------- 1. 定版参数一致性 ---------- */

function numericField(source, field) {
  const match = source.match(new RegExp(field + ":\\s*(\\d+)"));
  return match ? Number(match[1]) : null;
}

test("render_config 与 config/render_params.jsxinc 数值一致", () => {
  const shipped = read("config/render_params.jsxinc");
  const embedded = read(`${ENGINE}/render_config.jsx`);
  const fields = [
    "columns",
    "cellSize",
    "width",
    "height",
    "effectsPerSheet",
    "frameCount",
    "fps",
    "totalEffects",
    "staticEffects",
    "animatedEffects",
    "aerenderConcurrency",
  ];
  for (const field of fields) {
    assert.equal(
      numericField(embedded, field),
      numericField(shipped, field),
      `字段 ${field} 在扩展副本与仓库配置之间不一致`,
    );
  }
  assert.match(embedded, /pngOutputTemplate: "DreamEngine PNG Sequence"/);
});

/* ---------- 2. recipe 纯函数 ---------- */

test("recipe 的启发式只处理语义明确的四类属性", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;

  const color = recipe.heuristicValue("color");
  assert.equal(color.length, 3);

  // TwoD 实测会触发 AE 内部脚本异常（CC 系列 Center 是 0–1 归一化坐标），必须跳过
  assert.equal(recipe.heuristicValue("twoD", null, null, 256), undefined);
  assert.equal(recipe.heuristicValue("checkbox"), true);
  assert.equal(recipe.heuristicValue("oneD", 0, 100), 50);
  assert.equal(recipe.heuristicValue("oneD", null, 100), undefined);
  assert.equal(recipe.heuristicValue("other"), undefined);
});

test("recipe 把表达式控件族与音频族判为不渲图", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;
  assert.equal(recipe.isNoPreview("Expression Controls"), true);
  assert.equal(recipe.isNoPreview("表达式控制"), true);
  assert.equal(recipe.isNoPreview("Audio"), true);
  assert.equal(recipe.isNoPreview("音频"), true);
  assert.equal(recipe.isNoPreview("Blur & Sharpen"), false);
  assert.equal(recipe.isNoPreview("模糊和锐化"), false);
});

test("recipe 展示时点取合成中点", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  assert.equal(ctx.AEV_Recipe.presentationTime({ duration: 2 }), 1);
});

test("materials 能识别脚本，表达式扩展名不进入素材分类", () => {
  const ctx = loadModules([`${ENGINE}/materials.jsx`]);
  const materials = ctx.AEV_Materials;
  assert.equal(materials.classify("tool.jsx", "C:/Media/scripts/tool.jsx"), "script");
  assert.equal(materials.classify("tool.jsxbin", "C:/Media/scripts/tool.jsxbin"), "script");
  assert.equal(materials.classify("blink.expression"), "");
  assert.equal(materials.classify("notes.txt", "C:/Media/notes.txt"), "");
});

/* ---------- 3. previewgen ---------- */

test("previewgen 的容量规划按 8x8 网格与 6 帧计算", () => {
  const ctx = loadModules([
    `${ENGINE}/render_config.jsx`,
    `${ENGINE}/previewgen.jsx`,
  ]);
  const gen = ctx.AEV_PreviewGen;

  const full = gen.plan(64);
  assert.equal(full.sheets, 1);
  assert.equal(full.totalRenders, 6);

  const overshoot = gen.plan(80);
  assert.equal(overshoot.sheets, 2);
  assert.equal(overshoot.totalRenders, 12);

  assert.equal(gen.plan(0).sheets, 0);
});

test("previewgen 在模板列表缺失 PNG 时尝试内置 Hidden PNG 模板", () => {
  const ctx = loadModules([`${ENGINE}/previewgen.jsx`]);
  const gen = ctx.AEV_PreviewGen;
  assert.equal(gen.pngTemplate({ templates: ["Lossless", "PNG Sequence"] }), "PNG Sequence");
  assert.equal(gen.pngTemplate({ templates: ["无损", "高品质"] }), null);

  const calls = [];
  const outputModule = {
    templates: ["Lossless", "高品质"],
    applyTemplate(name) {
      calls.push(name);
      if (name !== "_HIDDEN Legacy PNG Sequence") throw new Error("not available");
    },
  };
  assert.equal(gen.applyPngTemplate(outputModule), "_HIDDEN Legacy PNG Sequence");
  assert.ok(calls.includes("_HIDDEN Legacy PNG Sequence"));

  const source = read(`${ENGINE}/previewgen.jsx`);
  assert.match(source, /throw new Error\("no_png_template"\)/);
});

test("previewgen 的临时合成清理不依赖 undo", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  assert.doesNotMatch(code, /\.copyToComp\(/);
  assert.match(code, /finally \{/);
  assert.match(code, /cells\[c\]\.remove\(\)/);
  assert.match(code, /queueItem\.remove\(\)/);
  assert.match(code, /cleanupArtifacts\(!!targetComp\)/);
});

test("渲染结束后只清内部对象，不删除预览文件", () => {
  const removed = [];
  let disposed = 0;
  function CompItem(name) {
    this.name = name;
  }
  CompItem.prototype.remove = function remove() {
    removed.push(this.name);
  };
  function FootageItem(name, path) {
    this.name = name;
    this.mainSource = { file: { name, fsName: path } };
  }
  FootageItem.prototype.remove = function remove() {
    removed.push(this.name);
  };

  const items = [
    new CompItem("DE_asset_photo_128"),
    new CompItem("DE_cell_000_00"),
    new CompItem("用户自己的合成"),
    new FootageItem("batch_000_0000.png", "C:/DreamEngine/data/thumbs/batch_000_0000.png"),
    new FootageItem("batch_1107_0000.png", "C:/DreamEngine/data/thumbs/batch_1107_0000.png"),
    new FootageItem("batch_999_0000.png", "C:/Media/batch_999_0000.png"),
  ];
  const app = {
    project: {
      numItems: items.length,
      item(index) {
        return items[index - 1];
      },
    },
  };
  const ctx = loadModules([`${ENGINE}/previewgen.jsx`], {
    app,
    CompItem,
    FootageItem,
    AEV_Assets: {
      dispose() {
        disposed++;
      },
    },
  });
  const report = JSON.parse(ctx.AEV_PreviewGen.cleanupArtifacts());
  assert.equal(report.removed, 4);
  assert.deepEqual(removed, [
    "batch_1107_0000.png",
    "batch_000_0000.png",
    "DE_cell_000_00",
    "DE_asset_photo_128",
  ]);
  assert.equal(disposed, 1);
});

test("清理会删除模板工程留下的额外 PNG 渲染队列项", () => {
  const removed = [];
  const comp = { name: "DE_RENDER_TARGET" };
  const items = [
    {
      comp,
      remove() { removed.push("template"); },
    },
    {
      comp,
      remove() { removed.push("duplicate"); },
    },
  ];
  const app = {
    project: {
      numItems: 0,
      item() { return null; },
      renderQueue: {
        numItems: items.length,
        item(index) { return items[index - 1]; },
      },
    },
  };
  const ctx = loadModules([`${ENGINE}/previewgen.jsx`], {
    app,
    CompItem: function CompItem() {},
    FootageItem: function FootageItem() {},
  });
  const report = JSON.parse(ctx.AEV_PreviewGen.cleanupArtifacts());
  assert.deepEqual(removed, ["duplicate"]);
  assert.equal(report.removed, 1);
});

test("模板专用 AE 清理只保留 DE_RENDER_TARGET 合成", () => {
  const removed = [];
  function CompItem(name) { this.name = name; }
  CompItem.prototype.remove = function remove() { removed.push(this.name); };
  function FootageItem(name) {
    this.name = name;
    this.mainSource = { file: { name, fsName: "C:/temp/" + name } };
  }
  FootageItem.prototype.remove = function remove() { removed.push(this.name); };
  const items = [
    new CompItem("DE_RENDER_TARGET"),
    new FootageItem("bg"),
    new FootageItem("template_render_[0000-0002].png"),
  ];
  const app = {
    project: {
      numItems: items.length,
      item(index) { return items[index - 1]; },
      renderQueue: { numItems: 1, item() { return null; } },
    },
  };
  const ctx = loadModules([`${ENGINE}/previewgen.jsx`], { app, CompItem, FootageItem });
  const report = JSON.parse(ctx.AEV_PreviewGen.cleanupArtifacts(true));
  assert.deepEqual(removed.sort(), ["bg", "template_render_[0000-0002].png"]);
  assert.equal(report.removed, 2);
});

test("Lumetri 颜色用饱和度调整替代渲染（真渲会挂死 AE）", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;
  assert.equal(recipe.isSurrogate("ADBE Lumetri"), true);
  assert.equal(recipe.effectNameFor("ADBE Lumetri"), "ADBE HUE SATURATION");
  const steps = recipe.stepsFor("ADBE Lumetri");
  assert.ok(steps && steps.length > 0, "替代方案要有参数");
  assert.ok(steps[0].names.includes("主饱和度"), "用饱和度代表 Lumetri");

  // 普通效果不受影响
  assert.equal(recipe.isSurrogate("ADBE Glo2"), false);
  assert.equal(recipe.effectNameFor("ADBE Glo2"), "ADBE Glo2");
  assert.equal(recipe.stepsFor("ADBE Glo2"), recipe.recipes["ADBE Glo2"]);
});

test("viewmodel 把 Lumetri 留在候选里（走替代方案），但排除会挂死的效果", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  // Lumetri 有替代方案，可以渲染
  assert.equal(view.isExcludable({ matchName: "ADBE Lumetri", category: "颜色校正" }), false);
  // 这些是真会挂死的
  assert.equal(view.isExcludable({ matchName: "ADBE Echo", category: "时间" }), true);
  assert.equal(view.isExcludable({ matchName: "ADBE AudWave", category: "" }), true);
  assert.equal(view.isExcludable({ matchName: "CC Hair", category: "模拟" }), true);
});

test("配方覆盖常用内置效果，每条都带参数名与值", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipes = ctx.AEV_Recipe.recipes;
  const keys = Object.keys(recipes);
  assert.ok(keys.length >= 45, `配方数量应 ≥ 45，实际 ${keys.length}`);
  for (const key of keys) {
    const steps = recipes[key];
    assert.ok(Array.isArray(steps) && steps.length > 0, `${key} 配方为空`);
    for (const step of steps) {
      assert.ok(step.names && step.names.length >= 1, `${key} 缺参数名`);
      assert.notEqual(step.value, undefined, `${key} 缺参数值`);
      for (const name of step.names) {
        assert.equal(typeof name, "string");
        assert.ok(name.length > 0, `${key} 有空白参数名`);
      }
    }
  }

  // 参数名必须与本机真实名字一致：
  //   ADBE 内置效果在中文界面下返回中文，CC 系列是第三方插件风格、始终返回英文。
  assert.ok(recipes["ADBE Gaussian Blur 2"][0].names.includes("模糊度"));
  assert.ok(recipes["CC Radial Blur"][0].names.includes("Amount"));
});

test("previewgen 用合成帧率换算渲染时长，不用面板播放帧率", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  // 6 帧按 12fps 算成 0.5 秒，在 30fps 合成上会渲出 15 帧（AE 2021 实测踩过）
  assert.match(code, /var CELL_FPS = 30;/);
  assert.match(code, /var durationSeconds = frames \/ CELL_FPS;/);
  assert.match(code, /queueItem\.timeSpanDuration = durationSeconds;/);
  assert.doesNotMatch(code, /timeSpanDuration = frames \/ fps/);
});

test("previewgen 把队列时间段限制在合成范围内，避免 AE 空白帧警告", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  assert.match(code, /displayStartTime/);
  assert.match(code, /neededEnd/);
  assert.match(code, /durationSeconds = Math\.min/);
});

test("previewgen 渲染前清掉同名历史帧", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  assert.match(code, /getFiles\(baseName \+ "_\*\.png"\)/);
});

test("previewgen 的标准素材尺寸必须是整数（AE 2021 addSolid 硬要求）", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  // addSolid(color, name, width, height, pixelAspect)：宽高不能是小数
  assert.doesNotMatch(
    code,
    /addSolid\([^)]*,\s*size \*/,
    "addSolid 的尺寸参数不得直接乘以比例，必须先 Math.round",
  );
  assert.match(code, /Math\.round\(size \* 0\.59\)/);
  assert.match(code, /Math\.round\(size \* 0\.23\)/);
});

test("manifest v2 同时支持单文件与帧序列", () => {
  const source = read(`${ENGINE}/previewgen.jsx`);
  assert.match(source, /"version":2/);
  assert.match(source, /"frameSrc":/);
  assert.match(source, /"src":/);
});

/* ---------- 4. store ---------- */

test("store 的写权限自检走 app.preferences，不再使用不存在的 app.settings", () => {
  const code = stripComments(read(`${ENGINE}/store.jsx`));
  assert.doesNotMatch(code, /app\.settings/);
  assert.match(code, /app\.preferences\.getPrefAsLong/);
  assert.match(code, /Pref_SCRIPTING_FILE_NETWORK_SECURITY/);
});

/** 最小内存文件系统，用来在 node 里跑 store.jsx 的写探测 */
function makeFsMock(allowWrite) {
  const written = new Set();
  class FileMock {
    constructor(path) {
      this.path = path;
      this.exists = written.has(path);
    }
    get fsName() {
      return this.path;
    }
    get parent() {
      return new (class {
        constructor(p) {
          this.fsName = p;
          this.exists = true;
        }
        create() {
          return true;
        }
      })(this.path.replace(/\/[^/]*$/, ""));
    }
    open() {
      if (!allowWrite) return false;
      written.add(this.path);
      this.exists = true;
      return true;
    }
    write() {}
    close() {}
    remove() {
      written.delete(this.path);
      this.exists = false;
      return true;
    }
  }
  class FolderMock {
    constructor(path) {
      this.fsName = path;
      this.exists = true;
    }
    create() {
      return true;
    }
  }
  FolderMock.myDocuments = { fsName: "C:/docs" };
  return { File: FileMock, Folder: FolderMock, written };
}

test("store 写权限以实际写文件为准，首选项只做快速否决", () => {
  const cases = [
    { pref: -1, allowWrite: true, expected: 1, label: "首选项读不到但能写" },
    { pref: 0, allowWrite: true, expected: 0, label: "首选项明确关闭" },
    { pref: 1, allowWrite: false, expected: 0, label: "首选项开着但写不进去" },
    { pref: null, allowWrite: false, expected: null, label: "两层都无法判定" },
  ];
  for (const item of cases) {
    const fs = makeFsMock(item.allowWrite);
    const app =
      item.pref === null
        ? {}
        : { preferences: { getPrefAsLong: () => item.pref } };
    const ctx = loadModules([`${ENGINE}/store.jsx`], {
      app,
      File: fs.File,
      Folder: fs.Folder,
    });
    assert.equal(
      ctx.AEV_Store.writePermission(),
      item.expected,
      `${item.label} 应返回 ${item.expected}`,
    );
  }
});

test("store 把所有数据写在 我的文档/DreamEngine 下", () => {
  const source = read(`${ENGINE}/store.jsx`);
  assert.match(source, /var ROOT_NAME = "DreamEngine";/);
  assert.match(source, /Folder\.myDocuments\.fsName/);
});

/* ---------- 5. bridge 加载顺序 ---------- */

test("bridge 的 engine 加载顺序满足依赖关系", () => {
  const source = read("cep/com.dreamengine.panel/js/bridge.js");
  const order = ["render_config", "store", "names", "assets", "recipe", "previewgen", "queue", "catalog"].map(
    (name) => source.indexOf(`engine/${name}.jsx`),
  );
  for (const index of order) assert.notEqual(index, -1, "加载清单缺少模块");
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], "engine 模块顺序必须满足依赖（config → store → names → assets → recipe → previewgen → queue）");
  }
});

/* ---------- names.jsx ---------- */

test("names 解析 TSV 并跳过表头", () => {
  const ctx = loadModules([`${ENGINE}/names.jsx`]);
  const names = ctx.AEV_Names;
  const tsv = [
    "matchName\tnameEn\tnameZh\tcategoryEn\tcategoryZh\tpluginHint\tnameZhSource",
    "ADBE Gaussian Blur 2\tGaussian Blur\t高斯模糊\tBlur & Sharpen\t模糊和锐化\t内置\thelpx",
    "S_Glow\tS_Glow\t\tSapphire\tSapphire\tSapphire\tcommunity",
  ].join("\n");
  const rows = names.parseTsv(tsv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].matchName, "ADBE Gaussian Blur 2");
  assert.equal(rows[0].nameZh, "高斯模糊");
  assert.equal(rows[1].nameZh, "");

  const index = names.buildIndex(rows);
  assert.equal(names.resolve(index, "ADBE Gaussian Blur 2", "x", "zh").name, "高斯模糊");
  assert.equal(names.resolve(index, "ADBE Gaussian Blur 2", "x", "en").name, "Gaussian Blur");
  // 第三方无中文时：中文模式回退英文，不机翻
  assert.equal(names.resolve(index, "S_Glow", "x", "zh").name, "S_Glow");
});

test("names 对表外效果走 L-C 兜底，显示本机名", () => {
  const ctx = loadModules([`${ENGINE}/names.jsx`]);
  const names = ctx.AEV_Names;
  const index = names.buildIndex([]);
  const resolved = names.resolve(index, "XX Unknown", "本机显示名", "zh");
  assert.equal(resolved.name, "本机显示名");
  assert.equal(resolved.level, "fallback");
  assert.equal(resolved.source, "local");
});

test("names 覆盖率统计命中与未命中", () => {
  const ctx = loadModules([`${ENGINE}/names.jsx`]);
  const names = ctx.AEV_Names;
  const index = names.buildIndex([{ matchName: "A", nameEn: "A" }, { matchName: "B", nameEn: "B" }]);
  const report = names.coverage(index, ["A", "B", "C", "D"]);
  assert.equal(report.total, 4);
  assert.equal(report.hit, 2);
  assert.equal(report.miss, 2);
  assert.equal(report.ratio, 50);
  assert.deepEqual(Array.from(report.missSamples), ["C", "D"]);
});

/* ---------- recipe 场景与指纹 ---------- */

test("recipe 按效果类型推断场景，文本类落 text", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;
  assert.equal(recipe.sceneFor("ADBE Text Animator"), "text");
  assert.equal(recipe.sceneFor("Anything", "文本"), "text");
  assert.equal(recipe.sceneFor("ADBE 3D Tracker", "3D 通道"), "3d-camera");
  assert.equal(recipe.sceneFor("ADBE Stroke"), "shape-mask");
  assert.equal(recipe.sceneFor("CC Radial Blur", "模糊和锐化"), "footage-2d");
  assert.equal(recipe.sceneFor("Anything", "音频"), "no-preview");
  assert.equal(recipe.sceneFor("Anything", "表达式控制"), "no-preview");
});

test("两层输入类效果单独识别，不能落到 footage-2d", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;
  // 这些效果在单层合成里「加上了但画面不变」，必须补第二图层
  for (const matchName of [
    "ADBE Displacement Map",
    "ADBE Compound Blur",
    "ADBE Set Matte3",
    "ADBE Calculations",
    "CC Composite",
    "CC Vector Blur",
    "ADBE Gradient Wipe",
  ]) {
    assert.equal(recipe.sceneFor(matchName), "two-layer-input", `${matchName} 应判为两层输入`);
  }
  // 只生成部分内容、留白要露出下层画面的
  for (const matchName of ["ADBE Fill", "ADBE Ramp", "ADBE 4ColorGradient", "ADBE Scribble Fill"]) {
    assert.equal(recipe.sceneFor(matchName), "adjustment", `${matchName} 应判为调整层`);
  }
});

test("场景布局描述准确：两层输入要背景+图案，调整层只要背景", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;

  const two = recipe.layoutFor("two-layer-input");
  assert.equal(two.needBg, true);
  assert.equal(two.needSource, true);
  assert.equal(two.base, "photo");

  const adj = recipe.layoutFor("adjustment");
  assert.equal(adj.needBg, true);
  assert.equal(adj.needSource, false);

  const plain = recipe.layoutFor("footage-2d");
  assert.equal(plain.needBg, false);
  assert.equal(plain.needSource, false);

  // 未知场景必须退化成最保守的单层布局，不能返回 undefined
  const unknown = recipe.layoutFor("no-such-scene");
  assert.equal(unknown.base, "photo");
  assert.equal(unknown.needBg, false);
});

test("bindLayers 只碰图层选择器，不动其它参数", () => {
  const types = { LAYER_INDEX: 6413, OneD: 6410, COLOR: 6411, CHECKBOX: 6416, TWO_D: 6412 };
  const ctx = loadModules([`${ENGINE}/recipe.jsx`], { PropertyValueType: types });
  const recipe = ctx.AEV_Recipe;

  const touched = [];
  function prop(name, type) {
    return {
      name,
      propertyValueType: type,
      numProperties: 0,
      setValue: (v) => touched.push(name + "=" + v),
    };
  }
  const group = {
    numProperties: 2,
    property: (i) =>
      [
        prop("置换图层", types.LAYER_INDEX),
        prop("最大水平置换", types.OneD),
      ][i - 1],
  };

  const bound = recipe.bindLayers(group, 2);
  assert.equal(bound, 1, "只应绑定 1 个图层选择器");
  assert.deepEqual(touched, ["置换图层=2"]);
});

test("recipe 场景到素材类型映射完整", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;
  assert.equal(recipe.assetKindFor("text"), "text");
  assert.equal(recipe.assetKindFor("solid-2d"), "solid");
  assert.equal(recipe.assetKindFor("shape-mask"), "shape");
  // 其余场景先用复合画面顶上
  for (const scene of ["footage-2d", "adjustment", "two-layer-input", "3d-camera"]) {
    assert.equal(recipe.assetKindFor(scene), "photo");
  }
});

test("缓存指纹随配方版本与素材版本变化，且不包含 AE 版本", () => {
  const ctx = loadModules([`${ENGINE}/recipe.jsx`]);
  const recipe = ctx.AEV_Recipe;
  const a = recipe.cacheKey("ADBE Glo2", "photo-v3", 256, 6);
  const b = recipe.cacheKey("ADBE Glo2", "photo-v3", 256, 6);
  const c = recipe.cacheKey("ADBE Glo2", "photo-v3", 256, 12);
  const d = recipe.cacheKey("ADBE Glo2", "photo-v4", 256, 6);
  assert.equal(a, b, "同输入必须同指纹");
  assert.notEqual(a, c, "帧数变化要换指纹");
  assert.notEqual(a, d, "素材版本变化要换指纹");
  assert.match(a, /^[0-9a-z]+$/);
});

/** 只读文件系统的 mock，用于在 node 里跑 previewgen.staleList */
function makeReadFs(text) {
  class FileMock {
    constructor(p) {
      this.path = p;
      this.exists = true;
      this.encoding = "";
      this._lines = text.split(/\r?\n/);
      this._cursor = 0;
    }
    get fsName() {
      return this.path;
    }
    open() {
      return true;
    }
    get eof() {
      return this._cursor >= this._lines.length;
    }
    readln() {
      const line = this._lines[this._cursor];
      this._cursor++;
      return line;
    }
    close() {}
  }
  return FileMock;
}

test("staleList 按指纹判定过期，不按 AE 版本跳过条目", () => {
  const header = "matchName\tsheet\tcell\tframes\tframeTemplate\tkey";
  // 先算出一条「当前配方下仍然有效」的真指纹
  const seed = loadModules([
    `${ENGINE}/render_config.jsx`,
    `${ENGINE}/recipe.jsx`,
    `${ENGINE}/previewgen.jsx`,
  ]);
  const cellSize = seed.AEV_PreviewGen.config().contactSheet.cellSize;
  const goodKey = seed.AEV_PreviewGen.itemKey("CC Lens", cellSize, 6);
  assert.ok(goodKey && goodKey.length > 0, "指纹不应为空");

  const tsv = [
    header,
    `CC Lens\t1\t0\t6\tthumbs/batch_001_%04d.png\t${goodKey}\t23`,
    "ADBE Glo2\t1\t1\t6\tthumbs/batch_001_%04d.png\tdeadbeef\t23",
    "ADBE Twirl\t1\t2\t6\tthumbs/batch_001_%04d.png\t\t23",
    "ADBE Twist\t1\t3\t6\tthumbs/batch_001_%04d.png\tdeadbeef\t21",
  ].join("\n");

  const ctx = loadModules(
    [`${ENGINE}/render_config.jsx`, `${ENGINE}/recipe.jsx`, `${ENGINE}/previewgen.jsx`],
    { File: makeReadFs(tsv), app: { version: "23.6.0" } },
  );
  const report = JSON.parse(ctx.AEV_PreviewGen.staleList("X:/ext"));
  assert.equal(report.checked, 4);
  assert.deepEqual(report.stale, ["ADBE Glo2", "ADBE Twist"], "旧 AE 版本的缓存也按指纹检查");
});

test("writeManifest 同步写 previews.tsv，供 AE 侧校验缓存", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  // ExtendScript 没有 JSON.parse，校验只能在 AE 侧读 TSV 做
  assert.match(code, /data\/previews\.tsv/);
  assert.match(code, /indexRows/);
  assert.match(code, /function itemKey/);
  assert.match(code, /function staleList/);
  assert.doesNotMatch(code, /aeMajor/);
});

test("writeManifest 保留旧条目指纹，只给新渲染条目计算新指纹", () => {
  const written = {};
  function FileMock(path) {
    this.path = String(path);
    this.exists = true;
    this.fsName = this.path;
    this.text = "";
  }
  FileMock.prototype.open = () => true;
  FileMock.prototype.write = function write(text) {
    this.text += String(text);
    written[this.path] = this.text;
  };
  FileMock.prototype.close = () => {};
  FileMock.prototype.remove = () => true;

  const ctx = loadModules(
    [
      `${ENGINE}/render_config.jsx`,
      `${ENGINE}/recipe.jsx`,
      `${ENGINE}/assets.jsx`,
      `${ENGINE}/previewgen.jsx`,
    ],
    { File: FileMock },
  );
  const tsv = [
    "CC Lens\t1\t0\t6\tthumbs/batch_001_%04d.png\t23\told-key",
    "ADBE Glo2\t1\t1\t6\tthumbs/batch_001_%04d.png\t23\t",
  ].join("\n");
  const report = JSON.parse(ctx.AEV_PreviewGen.writeManifest(tsv, "X:/ext", ""));
  assert.equal(report.status, "ok");

  const manifest = JSON.parse(written["X:/ext/data/manifest.json"]);
  assert.equal(manifest.items[0].key, "old-key");
  assert.ok(manifest.items[1].key && manifest.items[1].key !== "old-key");
  const index = written["X:/ext/data/previews.tsv"].split(/\r?\n/);
  assert.equal(index[1].split("\t")[5], "old-key");
});

test("L1 包里的 manifest 与 previews.tsv 条目一致，且都带指纹", () => {
  const manifest = JSON.parse(read("dist/L1/manifest.json"));
  const lines = read("dist/L1/previews.tsv").trim().split(/\r?\n/);
  const header = lines.shift().split("\t");
  assert.deepEqual(header.slice(0, 6), [
    "matchName",
    "sheet",
    "cell",
    "frames",
    "frameTemplate",
    "key",
  ]);
  assert.equal(lines.length, manifest.items.length, "两份索引的条目数必须一致");

  const byName = new Map(manifest.items.map((item) => [item.matchName, item]));
  let renderFrameKept = 0;
  for (const item of manifest.items) {
    assert.ok(item.key && item.key.length > 0, `${item.matchName} 缺指纹`);
  }
  for (const line of lines) {
    const cells = line.split("\t");
    const item = byName.get(cells[0]);
    assert.ok(item, `previews.tsv 里的 ${cells[0]} 不在 manifest 中`);
    assert.ok(cells[5] && cells[5].length > 0, `${cells[0]} 在 previews.tsv 里缺指纹`);
    assert.equal(cells[5], item.key, `${cells[0]} 两份索引的指纹必须一致`);

    // frames 列是**渲染帧数**，manifest 的 frames 是存储帧数。
    // 打包把静态格子从 6 帧压成 1 帧后，渲染帧数必须保留下来——
    // 否则 staleList 会拿 1 帧去比对按 6 帧算的指纹，把有效预览全判成过期。
    const renderFrames = Number(cells[3]);
    const storedFrames = item.frames || 1;
    assert.ok(renderFrames >= storedFrames, `${cells[0]} 渲染帧数不应小于存储帧数`);
    if (renderFrames > 1) renderFrameKept++;
  }
  assert.ok(renderFrameKept > 0, "previews.tsv 里应当记着渲染帧数（多帧渲染的条目）");
});

/* ---------- assets / catalog 静态契约 ---------- */

test("assets 按类型生成五套素材并复用缓存", () => {
  const code = stripComments(read(`${ENGINE}/assets.jsx`));
  assert.match(code, /var VERSION = "photo-v3";/);
  assert.match(code, /function buildPhoto/);
  assert.match(code, /function buildText/);
  assert.match(code, /function buildSolid/);
  assert.match(code, /function buildShape/);
  // 两层输入类效果需要高对比图案当第二输入
  assert.match(code, /function buildPattern/);
  assert.match(code, /resolvedKind === "pattern"/);
  assert.match(code, /cache\[key\(kind, size, background\)\] = \{ item: comp, deps: deps \|\| \[\] \};/);
  assert.match(code, /function dispose\(\)/);
  assert.match(code, /entry\.item\.remove\(\)/);
});

test("自定义效果背景只改变通用画面类效果的缓存指纹", () => {
  function FileMock(path) {
    this.path = String(path);
    this.exists = /\.png$/i.test(this.path);
    this.fsName = this.path;
    this.length = 4096;
    this.modified = { getTime: () => 123456 };
  }
  const ctx = loadModules(
    [
      `${ENGINE}/render_config.jsx`,
      `${ENGINE}/recipe.jsx`,
      `${ENGINE}/assets.jsx`,
      `${ENGINE}/previewgen.jsx`,
    ],
    { File: FileMock },
  );
  const gen = ctx.AEV_PreviewGen;
  const photoDefault = gen.itemKey("ADBE Glo2", 128, 6, "");
  const photoCustom = gen.itemKey("ADBE Glo2", 128, 6, "C:/Backgrounds/custom.png");
  const textDefault = gen.itemKey("ADBE Numbers2", 128, 6, "");
  const textCustom = gen.itemKey("ADBE Numbers2", 128, 6, "C:/Backgrounds/custom.png");
  assert.notEqual(photoDefault, photoCustom);
  assert.equal(textDefault, textCustom, "文字类效果仍使用专用文字素材");
});

test("设置页支持上传效果预览背景并贯通渲染参数", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const prefs = read("cep/com.dreamengine.panel/js/prefs.js");
  const library = read("cep/com.dreamengine.panel/js/library.js");
  const previewgen = read(`${ENGINE}/previewgen.jsx`);
  const assets = read(`${ENGINE}/assets.jsx`);

  assert.match(html, /id="btnEffectBackground"/);
  assert.match(html, /id="btnEffectBackgroundClear"/);
  assert.match(prefs, /effectBackground: effectBackground/);
  assert.match(library, /AEV_PreviewGen\.pickBackground\(\)/);
  assert.match(library, /JSON\.stringify\(state\.effectBackground\)/);
  assert.match(previewgen, /File\.openDialog\("选择效果预览背景"\)/);
  assert.match(previewgen, /DreamEngine\/backgrounds/);
  assert.match(
    previewgen,
    /var key = row\.key \|\| itemKey\(row\.matchName, cellSize, row\.frames, background\)/,
  );
  assert.match(assets, /function buildImportedPhoto/);
  assert.match(assets, /new ImportOptions\(source\)/);
  assert.match(assets, /app\.project\.importFile\(importOptions\)/);
  assert.match(assets, /\.sequence\s*=\s*false/);
});

test("预设预览把自定义背景作为单张图片导入，不尝试图片序列", () => {
  const src = read("cep/com.dreamengine.panel/engine/preset_preview.jsx");
  assert.match(src, /var importOptions = new ImportOptions\(file\)/);
  assert.match(src, /importOptions\.sequence\s*=\s*false/);
});

test("上传效果背景会复制到 DreamEngine 管理目录", () => {
  const copied = [];
  function FileMock(path) {
    this.fsName = String(path);
    this.path = String(path);
    this.name = this.path.split(/[\\/]/).pop();
    this.exists = false;
  }
  const source = new FileMock("C:/Users/test/Pictures/blue.png");
  source.exists = true;
  source.copy = function copy(target) {
    copied.push(target.fsName);
    target.exists = true;
    return true;
  };
  FileMock.openDialog = () => source;
  function FolderMock(path) {
    this.fsName = String(path);
    this.exists = false;
  }
  FolderMock.prototype.create = function create() {
    this.exists = true;
    return true;
  };
  FolderMock.myDocuments = { fsName: "C:/Users/test/Documents" };

  const ctx = loadModules([`${ENGINE}/previewgen.jsx`], {
    File: FileMock,
    Folder: FolderMock,
  });
  const report = JSON.parse(ctx.AEV_PreviewGen.pickBackground());
  assert.equal(report.status, "ok");
  assert.match(report.path, /DreamEngine\/backgrounds\/blue\.png$/);
  assert.deepEqual(copied, [report.path]);
});

test("效果预览背景选择会跨面板会话保存", () => {
  const values = {};
  const windowMock = {
    localStorage: {
      getItem(key) {
        return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
      },
      setItem(key, value) {
        values[key] = String(value);
      },
    },
  };
  const ctx = loadModules(
    ["cep/com.dreamengine.panel/js/prefs.js"],
    { window: windowMock },
  );
  assert.equal(ctx.AEV_Prefs.effectBackground(), "");
  ctx.AEV_Prefs.setEffectBackground("C:/Users/test/Documents/DreamEngine/backgrounds/blue.png");
  assert.equal(
    ctx.AEV_Prefs.effectBackground(),
    "C:/Users/test/Documents/DreamEngine/backgrounds/blue.png",
  );
});

test("两层输入场景会真的搭出两层：图案层 + 效果层", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  // 顺序必须是「背景 → 图案 → 效果层」，AE 里后加的在上面，
  // 于是效果层在第 1 层、图案层在第 2 层，图层选择器绑 2 才有意义。
  assert.match(code, /layout = AEV_Recipe\.layoutFor\(AEV_Recipe\.sceneFor\(matchName\)\)/);
  assert.match(code, /if \(layout\.needBg\) \{/);
  assert.match(code, /if \(layout\.needSource\) \{/);
  assert.match(code, /cell\.layers\.add\(sceneOf\("pattern"\)\)/);
  assert.match(code, /AEV_Recipe\.bindLayers\(effectGroup, 2\)/);
  // 背景层必须是纯色：遮罩吃掉上层时露出的颜色要和上层明显不同
  assert.match(code, /cell\.layers\.add\(sceneOf\("solid"\)\)/);
  // 第二输入层要隐藏，否则会盖住效果结果
  assert.match(code, /sourceLayer\.enabled = false;/);
});

test("catalog 参数树带深度与数量上限，且用完即删", () => {
  const code = stripComments(read(`${ENGINE}/catalog.jsx`));
  assert.match(code, /var MAX_DEPTH = 3;/);
  assert.match(code, /var MAX_PARAMS = 200;/);
  assert.match(code, /comp\.remove\(\)/);
  assert.match(code, /getParamTreeJson/);
  assert.match(code, /canVaryOverTime/);
});

test("catalog 记录 AE 主版本与效果自身版本", () => {
  const ctx = loadModules([`${ENGINE}/catalog.jsx`], {
    app: {
      version: "23.6.0",
      effects: [
        { matchName: "ADBE Glo2", displayName: "发光", category: "风格化", version: "23.0" },
      ],
    },
  });
  const data = JSON.parse(ctx.AEV_Catalog.getCatalogJson(true));
  assert.equal(data.aeVersion, "23.6.0");
  assert.equal(data.aeMajor, 23);
  assert.equal(data.effects[0].version, "23.0");
});

/* ---------- 6. queue ---------- */

test("queue 用 TSV 持久化，避免 ExtendScript 解析 JSON", () => {
  const code = stripComments(read(`${ENGINE}/queue.jsx`));
  assert.match(code, /var QUEUE_FILE = "cache\/queue\.tsv";/);
  assert.match(code, /var SEP = "\\t";/);
  assert.doesNotMatch(code, /JSON\.parse/);
});

test("queue 的状态机符合 pending → rendering → cached/failed", () => {
  const source = read(`${ENGINE}/queue.jsx`);
  for (const status of ['"pending"', '"rendering"', '"cached"', '"failed"']) {
    assert.ok(source.includes(status), `缺少状态 ${status}`);
  }
  assert.match(source, /var MAX_ATTEMPTS = 2;/);
});

test("queue 的 drain 一次只渲一张网并返回本批名单", () => {
  const source = read(`${ENGINE}/queue.jsx`);
  assert.match(source, /var limit = \(options && options\.limit\) \|\| perSheet;/);
  assert.match(source, /namesJson\.join\(","\)/);
  assert.match(source, /\\"names\\":\[/);
  assert.match(source, /renderBatch\(batch, sheetIndex, options\)/);
});

test("queue 能重新打开过期条目，且与失败重试区分开", () => {
  const source = read(`${ENGINE}/queue.jsx`);
  // 过期 ≠ 失败：配方改了不是渲染出错，重开时 attempts 要归零、不记 reason 为错误
  assert.match(source, /function reopen/);
  assert.match(source, /setStatus\(queue, name, "pending", "stale"\)/);
  assert.match(source, /reopen: reopen,/);
  // 仍然保留 retryFailed 的语义
  assert.match(source, /function retryFailed/);
});

/* ---------- 7. 面板侧 ---------- */

test("manifest 的 sheets.src 指向真实存在的帧文件", () => {
  const code = stripComments(read(`${ENGINE}/previewgen.jsx`));
  // 帧序列网的实体文件是 batch_XXX_0000.png，写 batch_XXX.png 会指向不存在的文件
  assert.match(code, /_0000\.png/);
});

test("面板优先渲染看得出差异的分类，并跳过 3D 通道族", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;

  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE 3D Tracker", category: "3D Channel" }), true);
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE 3D Glasses", category: "透视" }), true);
  // CS 前缀实测渲染报「滤镜无效」，整批会随之失败
  assert.equal(view.isPoorPreviewTarget({ matchName: "CS CrossBlur", category: "模糊和锐化" }), true);
  // CC Drizzle 实测在 2048 整网 × 6 帧下渲染挂起
  assert.equal(view.isPoorPreviewTarget({ matchName: "CC Drizzle", category: "模拟" }), true);
  // 音频族在无音频输入时无法求值：ADBE AudWave 一渲染就挂死
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE AudWave", category: "" }), true);
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE AudSpect", category: "生成" }), true);
  // CC Hair 是毛发模拟：打上关键帧后每帧都要重算，AE 直接挂死
  assert.equal(view.isPoorPreviewTarget({ matchName: "CC Hair", category: "模拟" }), true);
  // 文本生成器在 addProperty 时弹模态对话框，会卡死批量渲染
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE Numbers2", category: "文本" }), true);
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE Timecode", category: "文本" }), true);
  // Apply Color LUT2 渲染时弹「选择 LUT 文件」对话框，整批卡死
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE Apply Color LUT2", category: "颜色校正" }), true);
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE Gaussian Blur 2", category: "模糊和锐化" }), false);

  const blur = view.previewRank({ matchName: "ADBE Gaussian Blur 2", category: "模糊和锐化" });
  const unknown = view.previewRank({ matchName: "XX Something", category: "未收录分类" });
  const poor = view.previewRank({ matchName: "ADBE 3D Tracker", category: "3D Channel" });
  assert.ok(blur < unknown, "常用分类应排在未知分类之前");
  assert.ok(unknown < poor, "未知分类应排在已排除项之前");
});

test("候选按分类轮转，首批覆盖多个类别", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const list = [
    { matchName: "A1", category: "模糊和锐化" },
    { matchName: "A2", category: "模糊和锐化" },
    { matchName: "A3", category: "模糊和锐化" },
    { matchName: "B1", category: "扭曲" },
    { matchName: "C1", category: "颜色校正" },
  ];
  // Array.from 把 vm realm 的数组转成本 realm，否则 deepStrictEqual 会因原型不同而失败
  const out = Array.from(view.interleaveByCategory(list), (item) => item.matchName);
  assert.deepEqual(out.slice(0, 3), ["A1", "C1", "B1"], "首批应各分类各取一个");
  assert.equal(out[3], "A2", "之后继续填第二轮的模糊类");
  assert.equal(out.length, 5, "不得丢条目");
});

test("viewmodel 的 no-preview 规则与 recipe 保持一致", () => {
  const viewmodel = read("cep/com.dreamengine.panel/js/viewmodel.js");
  const recipe = read(`${ENGINE}/recipe.jsx`);
  for (const token of ["expression controls", "表达式控制", "audio", "音频"]) {
    assert.ok(viewmodel.toLowerCase().includes(token.toLowerCase()), `viewmodel 缺少 ${token}`);
    assert.ok(recipe.toLowerCase().includes(token.toLowerCase()), `recipe 缺少 ${token}`);
  }
});

test("面板对多帧预览按帧序列取图，而不是依赖 sprite 的 sheet.src", () => {
  const library = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(library, /frameSrc/);
  assert.match(library, /replace\("%04d", zeroPad\(index, 4\)\)/);
  assert.match(library, /setInterval/);
});

test("面板把过期预览排进生成队列，而不是当成已缓存", () => {
  const library = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(library, /AEV_PreviewGen\.staleList/);
  assert.match(library, /AEV_Queue\.reopen/);
  assert.match(library, /AEV_PreviewGen\.cleanupArtifacts/);
  assert.match(library, /keepAssets:true/);
  // 只有当前版本且不过期的预览才算完整；旧版回退仍进生成队列
  assert.match(library, /installedBuiltinNames/);
  assert.match(library, /isExactPreview\(effect\.matchName\) && !state\.stale\[effect\.matchName\]/);
  assert.match(
    library,
    /if \(state\.stale\[key\] \|\| !isExactPreview\(key\)\) staleNames\.push\(key\);/,
  );
});

test("面板显示当前 AE 效果清单，并选用最后一个有效预览", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const library = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(html, /id="showAll"[^>]*checked/);
  assert.match(library, /previewVariants/);
  assert.doesNotMatch(library, /catalogMajor|preview\.aeMajor/);
  assert.match(library, /choosePreview\(/);
});

test("viewmodel 给过期条目打标记，图仍然照常显示", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const effect = { matchName: "ADBE Glo2", displayName: "Glow", category: "风格化" };
  const preview = { matchName: "ADBE Glo2", src: "thumbs/batch_000.png", x: 0, y: 0 };
  const stale = { "ADBE Glo2": true };

  const item = view.buildItem(effect, {}, { "ADBE Glo2": preview }, stale);
  assert.equal(item.hasPreview, true, "过期也要继续显示旧图");
  assert.equal(item.stale, true);

  const fresh = view.buildItem(effect, {}, { "ADBE Glo2": preview }, {});
  assert.equal(fresh.stale, false);

  // 没有预览时谈不上过期
  const missing = view.buildItem(effect, {}, {}, stale);
  assert.equal(missing.hasPreview, false);
  assert.equal(missing.stale, false);
});

test("多个预览存在时选择最后一个有效项，不检查 AE 版本", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const variants = [
    { matchName: "ADBE Glo2", aeMajor: 21, src: "old.png" },
    { matchName: "ADBE Glo2", aeMajor: 23, src: "current.png" },
  ];
  assert.equal(view.choosePreview(variants).src, "current.png");
  assert.equal(
    view.choosePreview([
      { matchName: "ADBE Twirl", src: "first.png" },
      { matchName: "ADBE Twirl" },
      { matchName: "ADBE Twirl", src: "last.png" },
    ]).src,
    "last.png",
  );
  assert.equal(view.choosePreview([]), null);
});

test("排序：按名称首字母（中文按拼音）", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const items = [
    { matchName: "X1", nameEn: "Zeta", nameZh: "斑马纹", category: "风格化" },
    { matchName: "X2", nameEn: "Alpha", nameZh: "爱丽丝", category: "风格化" },
    { matchName: "X3", nameEn: "Mango", nameZh: "芒果", category: "风格化" },
  ];
  const byEn = Array.from(view.sortItems(items, "name", "en"), (i) => i.matchName);
  assert.deepEqual(byEn, ["X2", "X3", "X1"], "英文按字母序");

  // 中文按拼音：爱丽丝(ai) < 斑马纹(ban) < 芒果(mang)
  const byZh = Array.from(view.sortItems(items, "name", "zh"), (i) => i.matchName);
  assert.deepEqual(byZh, ["X2", "X1", "X3"], "中文按拼音序");
});

test("排序：按分类时同分类排在一起，类内按名称", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const items = [
    { matchName: "A", nameEn: "Zed", nameZh: "泽德", category: "扭曲" },
    { matchName: "B", nameEn: "Abe", nameZh: "艾比", category: "颜色校正" },
    { matchName: "C", nameEn: "Mid", nameZh: "米德", category: "扭曲" },
  ];
  const out = Array.from(view.sortItems(items, "category", "zh"), (i) => i.matchName);
  assert.equal(out.length, 3);
  // 同分类的两条必须相邻（分类名排序：扭 n < 颜 y，所以扭曲在前）
  const categories = out.map((key) => (key === "B" ? "颜色校正" : "扭曲"));
  assert.equal(categories[0], "扭曲");
  assert.equal(categories[1], "扭曲", "同分类必须相邻");
  assert.equal(categories[2], "颜色校正");
  // 类内按名称：艾比(ai) < 泽德(zé) < 米德(mǐ) → 扭曲类内应是 B? 不，是 米德 与 泽德
  const twisted = out.filter((key) => key !== "B").map((key) => (key === "A" ? "泽德" : "米德"));
  assert.deepEqual(twisted, ["米德", "泽德"], "类内按名称排序");
});

test("分类键用 AE 原始分类名，显示名走名字表映射", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const item = {
    matchName: "ADBE Glo2",
    nameEn: "Glow",
    nameZh: "发光",
    category: "风格化",
    categoryZh: "风格化",
    categoryEn: "Stylize",
  };
  // 键取原始分类（切语言不变），显示名取本地化
  assert.equal(view.categoryKey(item), "风格化");
  assert.equal(view.categoryLabel(item, "en"), "Stylize");
  assert.equal(view.categoryLabel(item, "zh"), "风格化");

  // 没有分类的归到「未分类」
  assert.equal(view.categoryKey({ matchName: "X" }), "未分类");
});

test("分类顺序取自 catalog 首次出现顺序", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const order = Array.from(view.categoryOrder([
    { matchName: "A", category: "模糊和锐化" },
    { matchName: "B", category: "颜色校正" },
    { matchName: "C", category: "模糊和锐化" },
    { matchName: "D", category: "扭曲" },
  ]));
  assert.deepEqual(order, ["模糊和锐化", "颜色校正", "扭曲"]);
});

test("分类计数用于侧栏", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const stats = view.categoryCounts(
    [
      { matchName: "A", category: "模糊和锐化" },
      { matchName: "B", category: "模糊和锐化" },
      { matchName: "C", category: "扭曲" },
    ],
    "zh",
  );
  assert.equal(stats.counts["模糊和锐化"], 2);
  assert.equal(stats.counts["扭曲"], 1);
});

/* ---------- sprite 切片：固定画面裁切 ---------- */

test("sprite 切片用百分比而不是固定像素，保证一格正好等于一个预览框", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const manifest = { cellSize: 128, columns: 8, width: 1024, height: 1024 };

  const slice = view.spriteSlice({ x: 0, y: 0 }, manifest);
  // 整网被放大到「格数 × 100%」，一格就等于预览框
  assert.equal(slice.size, "800.0000% 800.0000%", "background-size 应按格数放大");
  // 左上角格：偏移 0
  assert.equal(slice.position, "0.0000% 0.0000%");

  // 百分比定位的换算：offset = 百分比 × (容器 - 图片)，
  // 图片放大后比容器大，所以分母是 (格数 - 1)。
  const check = (cellX, cellY) => {
    const s = view.spriteSlice({ x: cellX * 128, y: cellY * 128 }, manifest);
    const [px, py] = s.position.split(" ").map((v) => Number(v.replace("%", "")));
    // 图片被放大 8 倍，容器宽 = 1 格；定位后目标格左上角应落在容器左上角
    const containerW = 1;
    const imageW = 8;
    const offsetX = (px / 100) * (containerW - imageW);
    const offsetY = (py / 100) * (containerW - imageW);
    assert.ok(
      Math.abs(offsetX + cellX) < 0.001,
      `第 ${cellX} 列横向偏移应为 -${cellX} 格，实际 ${offsetX}`,
    );
    assert.ok(
      Math.abs(offsetY + cellY) < 0.001,
      `第 ${cellY} 行纵向偏移应为 -${cellY} 格，实际 ${offsetY}`,
    );
  };

  check(0, 0);
  check(3, 0);
  check(7, 0);
  check(0, 5);
  check(7, 7);
  check(4, 2);
});

test("sprite 切片对最后一格也正确（百分比定位的边界）", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const manifest = { cellSize: 128, columns: 8, width: 1024, height: 1024 };
  const slice = view.spriteSlice({ x: 7 * 128, y: 7 * 128 }, manifest);
  assert.equal(slice.position, "100.0000% 100.0000%");
});

test("sprite 切片在列数为 1 时不除以零", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  const slice = view.spriteSlice({ x: 0, y: 0 }, { cellSize: 128, columns: 1, width: 128, height: 128 });
  assert.equal(slice.size, "100.0000% 100.0000%");
  assert.equal(slice.position, "0.0000% 0.0000%");
});

test("面板不再按数组位置取 sheet（数组顺序与 index 字段不一致）", () => {
  const library = read("cep/com.dreamengine.panel/js/library.js");
  // 必须按 index 建索引表
  assert.match(library, /sheetByIndex\[sheetList\[sh\]\.index\] = sheetList\[sh\]/);
  assert.match(library, /sheetByIndex\[preview\.sheet\]/);
  // 不能再用 sheets[preview.sheet] 取值（注释里提到不算）
  const code = library.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /sheets\[preview\.sheet\]/);
});

test("未分类的效果被排除（用户要求不要）", () => {
  const ctx = loadModules(["cep/com.dreamengine.panel/js/viewmodel.js"], { window: {} });
  const view = ctx.AEV_ViewModel;
  // AE 对一批效果不返回分类字段
  assert.equal(view.isExcludable({ matchName: "ADBE CM MoodLightAmorph", category: "" }), true);
  assert.equal(view.isExcludable({ matchName: "ADBE Color Swirl", category: "  " }), true);
  // 有分类的正常效果不受影响
  assert.equal(view.isExcludable({ matchName: "ADBE Gaussian Blur 2", category: "模糊和锐化" }), false);
});

test("面板的缩略图用 spriteSlice 而不是固定像素定位", () => {
  const library = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(library, /AEV_ViewModel\.spriteSlice\(preview, state\.manifest\)/);
  assert.match(library, /thumb\.style\.backgroundSize = slice\.size/);
  assert.match(library, /thumb\.style\.backgroundPosition = slice\.position/);
  // 固定像素定位会把相邻格子带进来
  assert.doesNotMatch(library, /backgroundPosition = "-" \+ preview\.x/);
});

test("面板提供分视图尺寸滑块，并写进当前视图 CSS 变量", () => {
  const library = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(library, /byId\("thumbSize"\)\.addEventListener/);
  assert.match(library, /--view-size/);
  assert.match(library, /effects:\s*132/);
  assert.match(library, /presets:\s*180/);
  assert.match(library, /materials:\s*132/);
  assert.match(library, /view === "curve"/);
  const html = read("cep/com.dreamengine.panel/index.html");
  assert.match(html, /id="thumbSize"/);
  assert.match(html, /type="range"/);
  const css = read("cep/com.dreamengine.panel/css/style.css");
  // 网格列宽跟随滑块
  assert.match(css, /--view-size/);
  assert.match(css, /\.preset-grid\s*\{[^}]*var\(--view-size/s);
  assert.match(css, /\.materials-grid/);
  // 左侧栏与右侧各自独立滚动：body 固定高度 + overflow hidden
  assert.match(css, /body \{[^}]*height: 100vh[^}]*overflow: hidden/s);
});

test("网格列宽是固定值，不被 1fr 拉伸（否则滑块形同虚设）", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  const gridBlock = css.match(/\.grid \{[^}]*\}/s);
  assert.ok(gridBlock, "找不到 .grid 规则");
  // minmax 的第二个值不能是 1fr —— 1fr 会把列拉满剩余宽度
  assert.doesNotMatch(
    gridBlock[0],
    /minmax\([^)]*,\s*1fr\)/,
    "列宽不能用 1fr：面板变宽时卡片会被拉伸，滑块设定的尺寸就失效了",
  );
  // 必须用固定宽度值
  assert.match(gridBlock[0], /var\(--view-size/);
});

test("侧栏不被拉成与右栏等高（滚动条不该贯穿整个面板）", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  const sidebarBlock = css.match(/\.sidebar \{[^}]*\}/s);
  assert.ok(sidebarBlock, "找不到 .sidebar 规则");
  assert.match(sidebarBlock[0], /align-self: flex-start/);
  assert.match(sidebarBlock[0], /max-height: 100%/);
});

test("侧栏宽度随面板收缩，窄面板下主区不被挤没", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  // 未手动拖动时仍保留响应式默认宽度；手动宽度写在父容器的 CSS 变量里。
  const workspaceBlock = css.match(/\.workspace \{[^}]*\}/s)[0];
  assert.match(workspaceBlock, /--category-width:\s*clamp\(/);
  const sidebarBlock = css.match(/\.sidebar \{[^}]*\}/s)[0];
  assert.doesNotMatch(sidebarBlock, /flex: 0 0 168px/);
  assert.match(sidebarBlock, /flex: 0 0 var\(--category-width/);
  // 主区要有最小宽度，保证至少能显示预览
  const mainBlock = css.match(/\nmain \{[^}]*\}/s)[0];
  assert.match(mainBlock, /min-width: \d+px/);
});

test("滑块范围固定 48–180px，窄面板下收敛实际尺寸并同步回滑块", () => {
  const library = read("cep/com.dreamengine.panel/js/library.js");
  const html = read("cep/com.dreamengine.panel/index.html");
  const css = read("cep/com.dreamengine.panel/css/style.css");
  // 范围固定：HTML 与 JS 都不能出现别的上下限
  assert.match(html, /id="thumbSize" type="range" min="48" max="180" step="2"/);
  assert.match(library, /var THUMB_MIN = 48;/);
  assert.match(library, /var THUMB_MAX = 180;/);
  assert.match(library, /var THUMB_STEP = 2;/);
  // 必须按可用宽度收敛，且滑块自身的 min/max 恒定（不随窗口比例改变）
  assert.match(library, /availableThumbWidth/);
  assert.match(library, /Math\.min\(thumbPreferred\[view\], limit\)/);
  assert.match(library, /slider\.min = String\(THUMB_MIN\)/);
  assert.match(library, /slider\.max = String\(THUMB_MAX\)/);
  // 收敛后写回实际值，避免「标 180、实际 150」的错位
  assert.match(library, /slider\.value = String\(value\)/);
  // 面板尺寸变化时要重新收敛
  assert.match(library, /addEventListener\("resize"/);
  // 下限 48px 时文字区要收紧
  assert.match(library, /classList\.toggle\("compact"/);
  assert.match(css, /\.grid\.compact \.card-name/);
});

test("预设角标在窄卡片里保持单行并省略，不竖排撑高", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  const badgeBlock = css.match(/\.preset-badge \{[^}]*\}/s);
  assert.ok(badgeBlock, "找不到 .preset-badge 规则");
  assert.match(badgeBlock[0], /max-width:\s*100%/);
  assert.match(badgeBlock[0], /overflow:\s*hidden/);
  assert.match(badgeBlock[0], /text-overflow:\s*ellipsis/);
  assert.match(badgeBlock[0], /white-space:\s*nowrap/);
});

test("设置页与曲线预设区使用细滚动条，不露出系统大滚动条", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  const scrollbarBlock = css.match(
    /\.settings-scroll::-webkit-scrollbar,[\s\S]*?\{[^}]*\}/s,
  );
  assert.ok(scrollbarBlock, "设置页与曲线预设区没有共用细滚动条规则");
  assert.match(scrollbarBlock[0], /\.curve-presets::-webkit-scrollbar/);
  assert.match(scrollbarBlock[0], /width:\s*[45]px/);
  assert.match(scrollbarBlock[0], /height:\s*[45]px/);
  const trackBlock = css.match(
    /\.settings-scroll::-webkit-scrollbar-track,[\s\S]*?\{[^}]*\}/s,
  );
  assert.ok(trackBlock, "缺少透明滚动轨道规则");
  assert.match(trackBlock[0], /\.curve-presets::-webkit-scrollbar-track/);
  assert.match(trackBlock[0], /background:\s*transparent/);
  const thumbBlock = css.match(
    /\.settings-scroll::-webkit-scrollbar-thumb,[\s\S]*?\{[^}]*\}/s,
  );
  assert.ok(thumbBlock, "缺少细滚动滑块规则");
  assert.match(thumbBlock[0], /\.curve-presets::-webkit-scrollbar-thumb/);
  assert.match(thumbBlock[0], /border:\s*0/);
});

/* ---------- 运行 ---------- */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed++;
    console.error(`[FAIL] ${name}`);
    console.error(String((error && error.stack) || error));
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
