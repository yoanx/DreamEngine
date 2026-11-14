#!/usr/bin/env node
/* ============================================================
 * test-plugin-preview.mjs —— 插件 L2 预览管线的静态回归
 *
 * 为什么不点 AE：插件混渲会直接杀掉 AE 进程，静态测试先把「安全边界、
 * 崩溃恢复、独立索引、面板合入」这四件事验死，实机逐条验证留到关闭 AE 后跑
 * tools/run_plugin_preview.jsx。
 *
 * 用法：node tools/test-plugin-preview.mjs
 * ============================================================ */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import vm from "node:vm";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

function loadScript(rel, globalName) {
  const ctx = vm.createContext({ window: {} });
  vm.runInContext(read(rel), ctx);
  return ctx[globalName];
}
const view = loadScript("cep/com.dreamengine.panel/js/viewmodel.js", "AEV_ViewModel");
const ps = loadScript("cep/com.dreamengine.panel/engine/plugin_state.jsx", "AEV_PluginState");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ---------- 1. 内置 / 插件分界 ---------- */

test("内置效果按 matchName 前缀判定，插件不会被误认成内置", () => {
  for (const mn of ["ADBE Glo2", "APC Foo", "CC Blur", "CS CrossBlur"]) {
    assert.equal(view.isBuiltinEffect({ matchName: mn }), true, mn);
  }
  for (const mn of ["BCC Glow", "S_Glow", "RG Universe Foo", "RE:Vision Bar", "VIDEOCOPILOT Saber", "Pseudo/Duik"]) {
    assert.equal(view.isBuiltinEffect({ matchName: mn }), false, mn);
  }
  assert.equal(view.isBuiltinEffect({}), false);
});

test("inferPlugin 覆盖已知插件包，散类统一归「其它插件」", () => {
  assert.equal(view.inferPlugin({ matchName: "BCC Glow", category: "BCC Lights" }), "BCC");
  assert.equal(view.inferPlugin({ matchName: "S_Glow", category: "Sapphire Lighting" }), "Sapphire");
  assert.equal(view.inferPlugin({ matchName: "ADBE Glo2", category: "风格化" }), "内置");
  // 厂商把 category 写成中文分类名，不能拿分类名当插件名
  assert.equal(view.inferPlugin({ matchName: "FooBar", category: "杂色和颗粒" }), "其它插件");
  assert.equal(view.inferPlugin({ matchName: "FooBar", category: "" }), "其它插件");
});

/* ---------- 2. 心跳日志与崩溃恢复 ---------- */

test("心跳日志：未配对的 BEGIN = 上次崩掉的元凶", () => {
  const log = [
    "RUN||todo=4 pending=4",
    "BEGIN|BCC Glow|sheet=1000",
    "OK|BCC Glow|sheet=1000",
    "BEGIN|S_Glow|sheet=1001",
    "FAIL|S_Glow|no_png_template",
    "BEGIN|BCC Lens Flare|sheet=1002"
  ].join("\n");
  const parsed = ps.parseLog(log);
  assert.deepEqual(Array.from(parsed.crashed), ["BCC Lens Flare"]);
  assert.equal(parsed.lines.length, 6);
});

test("多次崩溃会全部拉黑，SKIP 后不再重复判定", () => {
  const parsed = ps.parseLog(
    ["BEGIN|A|s=1", "BEGIN|B|s=2", "OK|A|s=1", "BEGIN|C|s=3"].join("\n"),
  );
  assert.deepEqual(Array.from(parsed.crashed), ["B", "C"]);
  const after = ps.parseLog(
    parsed.lines.concat(["SKIP|B|crash", "SKIP|C|crash"]).join("\n"),
  );
  assert.deepEqual(Array.from(after.crashed), []);
});

test("黑名单 TSV 往返 + 面板 JSON 可读", () => {
  const map = ps.mergeBlacklist({}, ["BCC Glow", "S_Glow"], "crash");
  const tsv = ps.blacklistTsv(map);
  const back = ps.readBlacklist(tsv);
  assert.equal(back["BCC Glow"], "crash");
  assert.equal(back["S_Glow"], "crash");
  const json = JSON.parse(ps.blacklistJson(back));
  assert.equal(json.version, ps.VERSION);
  assert.equal(json.items.length, 2);
  assert.equal(json.items[0].reason, "crash");
  assert.equal(ps.mergeBlacklist(back, ["X"], "render_error")["X"], "render_error");
});

/* ---------- 3. 独立 L2 索引 ---------- */

test("条目 TSV 往返，同名条目重渲时替换而不是追加", () => {
  const entries = [
    { matchName: "BCC Glow", sheet: 1000, frames: 24, fps: 24, duration: 1, previewVersion: 2, frameTemplate: "thumbs/batch_1000_%04d.png", plugin: "BCC" },
    { matchName: "S_Glow", sheet: 1001, frames: 24, fps: 24, duration: 1, previewVersion: 2, frameTemplate: "thumbs/batch_1001_%04d.png", plugin: "Sapphire" }
  ];
  const back = ps.readEntries(ps.entriesTsv(entries));
  assert.equal(back.length, 2);
  assert.equal(back[0].fps, 24);
  assert.equal(back[0].duration, 1);
  assert.equal(back[0].previewVersion, 2);
  assert.equal(back[1].frameTemplate, "thumbs/batch_1001_%04d.png");
  const replaced = ps.addEntry(back, {
    matchName: "BCC Glow", sheet: 1002, frames: 24, fps: 24, duration: 1, previewVersion: 2,
    frameTemplate: "thumbs/batch_1002_%04d.png", plugin: "BCC"
  });
  assert.equal(replaced.length, 2);
  assert.equal(ps.readEntries(ps.entriesTsv(replaced))[1].sheet, 1002);
});

test("planRun 跳过已有预览与黑名单，并限流", () => {
  const todo = [
    { matchName: "A", frames: 6, plugin: "BCC" },
    { matchName: "B", frames: 6, plugin: "BCC" },
    { matchName: "C", frames: 6, plugin: "Sapphire" },
    { matchName: "D", frames: 6, plugin: "Sapphire" }
  ];
  const done = [{ matchName: "A" }];
  const black = { B: "crash" };
  const run = ps.planRun(todo, done, black, 1);
  assert.deepEqual(Array.from(run).map((x) => x.matchName), ["C"]);
  assert.equal(run[0].frames, 6);
});

test("planRun force 会越过已有预览和黑名单，并跳过本轮已处理项", () => {
  const todo = [
    { matchName: "A", frames: 6, plugin: "BCC" },
    { matchName: "B", frames: 6, plugin: "BCC" },
    { matchName: "C", frames: 6, plugin: "Sapphire" },
  ];
  const run = ps.planRun(
    todo,
    [{ matchName: "A" }],
    { B: "crash" },
    8,
    { force: true, skip: { A: true } },
  );
  assert.deepEqual(Array.from(run).map((x) => x.matchName), ["B", "C"]);
});

test("planStats 以当前 AE 插件清单计算总量、完成、黑名单和剩余", () => {
  const todo = [
    { matchName: "A" },
    { matchName: "B" },
    { matchName: "C" },
    { matchName: "D" },
  ];
  const stats = ps.planStats(todo, [{ matchName: "A" }, { matchName: "C" }], {
    B: "crash",
  });
  assert.deepEqual(
    { total: stats.total, done: stats.done, blacklisted: stats.blacklisted, pending: stats.pending },
    { total: 4, done: 2, blacklisted: 1, pending: 1 },
  );
});

test("独立 manifest 是 1×1 单格，条目自带布局且 sheet 按 index 可取", () => {
  const entries = [{
    matchName: "BCC Glow", sheet: 1000, frames: 24, previewVersion: 2,
    frameTemplate: "thumbs/batch_1000_%04d.png", plugin: "BCC"
  }];
  const manifest = JSON.parse(ps.buildManifest(entries, {
    cellSize: 360, columns: 1, width: 360, height: 360
  }));
  assert.equal(manifest.columns, 1);
  assert.equal(manifest.cellSize, 360);
  assert.equal(manifest.width, 360);
  assert.equal(manifest.items.length, 1);
  const item = manifest.items[0];
  assert.equal(item.sliceColumns, 1);
  assert.equal(item.sliceCellSize, 360);
  assert.equal(item.sliceWidth, 360);
  assert.equal(item.sliceHeight, 360);
  // width/height 保持与 L1 item 相同的「格子尺寸」语义
  assert.equal(item.width, 360);
  assert.equal(item.height, 360);
  assert.equal(item.x, 0);
  assert.equal(item.y, 0);
  assert.equal(item.fps, 24);
  assert.equal(item.duration, 1);
  assert.equal(item.effectPreviewVersion, 2);
  assert.equal(item.plugin, "BCC");
  assert.equal(item.frameSrc, "thumbs/batch_1000_%04d.png");
  assert.equal(item.src, "thumbs/batch_1000_0000.png");
  assert.equal(manifest.sheets[0].index, 1000);
  assert.equal(manifest.sheets[0].src, "thumbs/batch_1000_0000.png");
  // 不能出现重复键（会把 width/height 覆盖成不同值）
  assert.equal((ps.buildManifest(entries).match(/"width":/g) || []).length, 3);
});

test("插件 manifest 支持同一切图里的 8 个格子", () => {
  const entries = [
    {
      matchName: "BCC A",
      sheet: 2000,
      frames: 6,
      frameTemplate: "thumbs/batch_2000_%04d.png",
      plugin: "BCC",
      x: 0,
      y: 0,
      columns: 8,
      width: 1024,
      height: 128,
      cellSize: 128,
    },
    {
      matchName: "BCC B",
      sheet: 2000,
      frames: 6,
      frameTemplate: "thumbs/batch_2000_%04d.png",
      plugin: "BCC",
      x: 128,
      y: 0,
      columns: 8,
      width: 1024,
      height: 128,
      cellSize: 128,
    },
  ];
  const roundTrip = ps.readEntries(ps.entriesTsv(entries));
  assert.equal(roundTrip[1].x, 128);
  assert.equal(roundTrip[1].columns, 8);
  assert.equal(roundTrip[1].width, 1024);
  assert.equal(roundTrip[1].height, 128);

  const manifest = JSON.parse(ps.buildManifest(entries, {
    cellSize: 128,
    columns: 1,
    width: 128,
    height: 128,
  }));
  assert.equal(manifest.items[0].x, 0);
  assert.equal(manifest.items[1].x, 128);
  assert.equal(manifest.items[1].sliceColumns, 8);
  assert.equal(manifest.items[1].sliceWidth, 1024);
  assert.equal(manifest.items[1].sliceHeight, 128);
  assert.equal(manifest.sheets.length, 1);
  assert.equal(manifest.sheets[0].index, 2000);
  assert.equal(manifest.sheets[0].width, 1024);
  assert.equal(manifest.sheets[0].height, 128);
});

test("spriteSlice 对插件单格图按条目布局切片，不套 L1 整网参数", () => {
  const slice = view.spriteSlice(
    {
      sliceColumns: 1, sliceCellSize: 128, sliceWidth: 128, sliceHeight: 128,
      width: 128, height: 128, x: 0, y: 0
    },
    { columns: 8, cellSize: 128, width: 1024, height: 1024 },
  );
  assert.equal(slice.size, "100.0000% 100.0000%");
  assert.equal(slice.position, "0.0000% 0.0000%");
});

test("L1 条目的 width/height 是格子尺寸，不能被误当成整图布局", () => {
  // 回归：曾把 item.width/height 当整图，rows 变 1，非首格全部切到 (0,0)
  const slice = view.spriteSlice(
    { x: 0, y: 128, width: 128, height: 128 },
    { columns: 8, cellSize: 128, width: 1024, height: 1024 },
  );
  assert.equal(slice.size, "800.0000% 800.0000%");
  assert.equal(slice.position, "0.0000% 14.2857%");
});

/* ---------- 4. 渲染隔离与离线脚本 ---------- */

test("renderBatch 支持 singleCell：1×1 单格，不改默认整网行为", () => {
  const gen = read("cep/com.dreamengine.panel/engine/previewgen.jsx");
  assert.match(gen, /var singleCell = !!\(options && options\.singleCell\)/);
  assert.match(gen, /var columns = singleCell \? 1 : \(requestedColumns > 0/);
  assert.match(gen, /requestedColumns > 0 \? columns \* cellSize : conf\.contactSheet\.width/);
  assert.match(gen, /requestedRows > 0 \? requestedRows \* cellSize : conf\.contactSheet\.height/);
  assert.match(gen, /var cellOffset = singleCell \? 0 :/);
  // 默认路径仍然取全局定版配置
  assert.match(gen, /var cellSize = conf\.contactSheet\.cellSize/);
});

test("AE 21/23 使用各自版本的渲染模板，不能共用随包 AE 23 模板", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "dreamengine-template-paths-"));
  try {
    const fakeRoot = resolve(temp, "Adobe");
    const probe = resolve(temp, "probe");
    const aePaths = [];
    for (const year of ["2021", "2023"]) {
      const support = resolve(fakeRoot, `Adobe After Effects ${year}`, "Support Files");
      mkdirSync(support, { recursive: true });
      const exe = resolve(support, "AfterFX.exe");
      writeFileSync(exe, "", "utf8");
      aePaths.push(exe);
    }
    const script = resolve(temp, "check-template-paths.ps1");
    writeFileSync(
      script,
      [
        "$ErrorActionPreference = 'Stop'",
        `. '${resolve(ROOT, "tools/ae_render_template.ps1").replace(/'/g, "''")}'`,
        `Get-AeRenderTemplatePath -Ae '${aePaths[0].replace(/'/g, "''")}' -Probe '${probe.replace(/'/g, "''")}'`,
        `Get-AeRenderTemplatePath -Ae '${aePaths[1].replace(/'/g, "''")}' -Probe '${probe.replace(/'/g, "''")}'`,
      ].join("\r\n"),
      "utf8",
    );
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim());
    assert.deepEqual(output, [
      resolve(probe, "render_templates", "DreamEnginePNG-ae2021-v1.aep"),
      resolve(probe, "render_templates", "DreamEnginePNG-ae2023-v1.aep"),
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("缺少所选 AE 版本模板时只构建一次，之后直接复用", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "dreamengine-template-build-"));
  try {
    const support = resolve(temp, "Adobe", "Adobe After Effects 2021", "Support Files");
    const probe = resolve(temp, "probe");
    const counter = resolve(temp, "launches.txt");
    mkdirSync(support, { recursive: true });
    const fakeAe = resolve(support, "AfterFX.cmd");
    writeFileSync(
      fakeAe,
      [
        "@echo off",
        `echo launch>>"${counter}"`,
        "echo fake-aep>\"%DREAMENGINE_TEMPLATE_PATH%\"",
        "exit /b 0",
      ].join("\r\n"),
      "utf8",
    );
    const builder = resolve(temp, "build.jsx");
    const loader = resolve(temp, "loader.jsx");
    writeFileSync(builder, "", "utf8");
    writeFileSync(loader, "", "utf8");
    const script = resolve(temp, "prepare-template.ps1");
    writeFileSync(
      script,
      [
        "$ErrorActionPreference = 'Stop'",
        `. '${resolve(ROOT, "tools/ae_render_template.ps1").replace(/'/g, "''")}'`,
        `$first = Resolve-AeRenderTemplate -Ae '${fakeAe.replace(/'/g, "''")}' -Probe '${probe.replace(/'/g, "''")}' -BuilderScript '${builder.replace(/'/g, "''")}' -LoaderScript '${loader.replace(/'/g, "''")}' -TimeoutSec 15`,
        `$second = Resolve-AeRenderTemplate -Ae '${fakeAe.replace(/'/g, "''")}' -Probe '${probe.replace(/'/g, "''")}' -BuilderScript '${builder.replace(/'/g, "''")}' -LoaderScript '${loader.replace(/'/g, "''")}' -TimeoutSec 15`,
        "Write-Output $first",
        "Write-Output $second",
      ].join("\r\n"),
      "utf8",
    );
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
      { encoding: "utf8" },
    )
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim());
    const expected = resolve(probe, "render_templates", "DreamEnginePNG-ae2021-v1.aep");
    assert.deepEqual(output, [expected, expected]);
    assert.equal(readFileSync(counter, "utf8").trim().split(/\r?\n/).length, 1);
    assert.equal(readFileSync(expected, "utf8").trim(), "fake-aep");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("效果与预设调度都把版本化模板传给离线渲染器", () => {
  const helper = read("tools/ae_render_template.ps1");
  const builder = read("tools/build_png_template.jsx");
  const loader = read("tools/run_template_builder_loader.jsx");
  const effectScheduler = read("tools/generate_plugin_effects.ps1");
  const presetScheduler = read("tools/generate_plugin_presets.ps1");

  assert.match(helper, /function Resolve-AeRenderTemplate/);
  assert.match(builder, /DREAMENGINE_TEMPLATE_PATH/);
  assert.match(builder, /DREAMENGINE_TEMPLATE_AUDIT/);
  assert.match(loader, /template_builder_script_path\.txt/);
  assert.match(effectScheduler, /Resolve-AeRenderTemplate/);
  assert.match(presetScheduler, /Resolve-AeRenderTemplate/);
  assert.match(effectScheduler, /plugin_render_template_path\.txt/);
  assert.match(presetScheduler, /preset_render_template_path\.txt/);
});

test("效果渲染前会为所选 AE 自动补齐同版本效果目录", () => {
  const flow = read("hub/renderer/flow.js");
  assert.match(flow, /async function ensureEffectCatalogForSelectedAe/);
  assert.match(flow, /window\.hub\.scanPluginEffects\(/);
  assert.match(flow, /catalogMeta[\s\S]{0,240}aeMajor/);
  assert.match(flow, /await ensureEffectCatalogForSelectedAe\(\)/);
});

test("单条隔离渲染遇到无帧结果时会重试一次", () => {
  const jsx = read("tools/run_plugin_preview.jsx");
  const start = jsx.indexOf("function renderSingleRaw(item");
  const end = jsx.indexOf("function renderGroup(group)");
  assert.ok(start >= 0 && end > start, "renderSingle 调用链定位失败");
  const body = jsx.slice(start, end);
  assert.match(body, /no_frames/);
  assert.match(body, /renderBatch/);
});

/* ---------- 5. 面板与名单工具 ---------- */

test("面板：插件预览只进 previews，不进 entries；生成按钮跳过插件", () => {
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(lib, /data\/plugin_manifest\.json/);
  assert.match(lib, /data\/plugin_blacklist\.json/);
  assert.match(lib, /addPreviewVariant\(pluginPreview\)/);
  assert.doesNotMatch(lib, /state\.entries\.push\(pluginPreview/);
  assert.match(lib, /待离线生成/);
  assert.match(lib, /已跳过/);
});

test("离线脚本：逐条 singleCell + 心跳 + 独立索引，绝不碰主 manifest", () => {
  const jsx = read("tools/run_plugin_preview.jsx");
  assert.match(jsx, /singleCell: true/);
  assert.match(jsx, /appendLog\("BEGIN", item\.matchName/);
  assert.match(jsx, /parsed\.crashed/);
  assert.match(jsx, /plugin_manifest\.json/);
  assert.match(jsx, /plugin_previews\.tsv/);
  assert.match(jsx, /plugin_blacklist\.tsv/);
  assert.doesNotMatch(jsx, /data\/manifest\.json/);
  assert.match(jsx, /AEV_PreviewGen\.renderBatch\(\[item\.matchName\]/);
  // Hub 模式下由当前 AE 自己枚举插件，不再依赖旧的 AE 2021 导出清单
  assert.match(jsx, /plugin_auto_catalog\.enabled/);
  assert.match(jsx, /app\.effects/);
  assert.match(jsx, /js\/viewmodel\.js/);
  assert.match(jsx, /plugin_background\.txt/);
  assert.match(jsx, /var runOptions = forceMode \? \{ force: true, skip: processed \} : null;/);
  assert.match(jsx, /PS\.planStats\(todo, entries, blacklist, runOptions\)/);
  assert.match(jsx, /while \(true\)/);
  assert.match(jsx, /PS\.planRun\(todo, entries, blacklist, limit, runOptions\)/);
  assert.match(jsx, /plugin_catalog_only\.enabled/);
  assert.match(jsx, /plugin_selection\.enabled/);
  assert.match(jsx, /plugin_force\.enabled/);
  assert.match(jsx, /Folder\.userData\.fsName \+ "\/Adobe\/CEP\/extensions\/com\.dreamengine\.panel"/);
  assert.match(jsx, /Folder\.myDocuments\.fsName \+ "\/DreamEngineProbe"/);
  assert.match(jsx, /matchName\\tdisplayName\\tcategory\\tplugin\\texcluded\\treason\\tnoPreview/);
  assert.match(jsx, /previewKey: AEV_ViewModel\.previewKey/);
  assert.match(jsx, /plugin_max_items\.txt/);
  assert.match(jsx, /pending=" \+ finalProgress\.pending/);
});

test("Hub 渲染页提供插件效果模式和调度入口", () => {
  const html = read("hub/renderer/index.html");
  const flow = read("hub/renderer/flow.js");
  const preload = read("hub/preload.js");
  const main = read("hub/main.js");
  const scheduler = read("tools/generate_plugin_effects.ps1");

  assert.match(html, /id="flowKindEffect"/);
  assert.match(flow, /window\.hub\.startPluginEffects\(/);
  assert.match(flow, /pluginEffectsSnapshot\(/);
  assert.match(preload, /plugin-effects:start/);
  assert.match(main, /new PluginEffectJob/);
  assert.match(scheduler, /plugin_effect_state\.json/);
  assert.match(scheduler, /run_plugin_preview_loader\.jsx/);
  assert.match(scheduler, /run_plugin_preview\.jsx/);
  assert.match(scheduler, /plugin_auto_catalog\.enabled/);
  assert.match(scheduler, /\[switch\]\$CatalogOnly/);
  assert.match(scheduler, /\[string\]\$Todo = ""/);
  assert.match(scheduler, /\[switch\]\$Force/);
  assert.match(scheduler, /plugin_selection\.enabled/);
  assert.match(scheduler, /plugin_catalog_only\.enabled/);
  assert.match(scheduler, /plugin_effect_catalog\.meta\.json/);
  assert.match(scheduler, /plugin_preview_script_path\.txt/);
  assert.match(scheduler, /Join-Path \$env:TEMP "DreamEnginePluginRunner"/);
});

test("插件效果脚本通过小加载器执行，兼容 AE 2023 的直接 -r 解析", () => {
  const loader = read("tools/run_plugin_preview_loader.jsx");
  const scheduler = read("tools/generate_plugin_effects.ps1");
  assert.match(loader, /plugin_preview_script_path\.txt/);
  assert.match(loader, /plugin_preview_script_path\.txt/);
  assert.match(loader, /eval\(script\)/);
  assert.match(loader, /plugin_preview_loader_error\.txt/);
  assert.match(scheduler, /plugin_preview_script_path\.txt/);
  assert.match(scheduler, /DreamEnginePluginRunner/);
  assert.match(scheduler, /RESULT\|\*/);
  assert.match(scheduler, /if \(-not \$process\.HasExited\) \{ Stop-AeProcess -Process \$process \}/);
  assert.match(scheduler, /已完成 \{0\} \/ \{1\}，剩余 \{2\}/);
  assert.match(scheduler, /\[int\]\$MaxItems = 0/);
  assert.match(scheduler, /if \(\$resultPending -eq 0\)/);
});

test("强制重渲只作用于第一轮，后续轮次回到增量模式", () => {
  const scheduler = read("tools/generate_plugin_effects.ps1");
  assert.match(
    scheduler,
    /if \(\$round -gt 1\)[\s\S]{0,260}Remove-Item -LiteralPath \$forceMarkerPath[\s\S]{0,120}\$Force = \$false/,
  );
});

test("插件预设脚本使用同样的加载器链路，并在 pending=0 时停止重启 AE", () => {
  const loader = read("tools/run_plugin_preset_loader.jsx");
  const jsx = read("tools/run_plugin_preset_preview.jsx");
  const scheduler = read("tools/generate_plugin_presets.ps1");

  assert.match(loader, /preset_plugin_preview_script_path\.txt/);
  assert.match(loader, /eval\(script\)/);
  assert.match(jsx, /pending=" \+ finalPending/);
  assert.match(scheduler, /DreamEnginePluginRunner/);
  assert.match(scheduler, /preset_plugin_preview_script_path\.txt/);
  assert.doesNotMatch(scheduler, /& \$AE -r \$jsx/);
  assert.match(scheduler, /if \(\$resultPending -eq 0\)/);
  assert.match(scheduler, /\[string\]\$PresetList = ""/);
  assert.match(scheduler, /\$selectedPresets/);
  assert.match(scheduler, /Write-Utf8 \$forcePath "selection"/);
});

test("插件效果会重试普通渲染错误，输出模板故障不会污染黑名单", () => {
  const jsx = read("tools/run_plugin_preview.jsx");
  const scheduler = read("tools/generate_plugin_effects.ps1");

  assert.match(jsx, /plugin_retry_errors\.enabled/);
  assert.match(jsx, /blacklist\[key\] === "render_error"/);
  assert.match(jsx, /function isInfrastructureFailure/);
  assert.match(jsx, /no_png_template/);
  assert.match(jsx, /fatal=/);
  assert.match(scheduler, /fatal=\(\[\^\\s\]\+\)/);
});

test("插件效果检测 AE 原生报错，跳过当前条目并继续下一轮", () => {
  const scheduler = read("tools/generate_plugin_effects.ps1");
  const watchdog = read("tools/ae_watchdog.ps1");
  assert.match(scheduler, /ae_watchdog\.ps1/);
  assert.match(scheduler, /Get-AEDialogInfo/);
  assert.match(scheduler, /Get-UnfinishedBeginPaths/);
  assert.match(scheduler, /Fail-PluginEffect/);
  assert.match(scheduler, /plugin_active_batch\.tsv/);
  assert.match(scheduler, /render_error/);
  assert.match(scheduler, /继续/);
  assert.match(watchdog, /EnumWindows/);
  assert.match(watchdog, /#32770/);
  assert.match(watchdog, /Severity/);
  assert.match(watchdog, /Close-AEDialogInfo/);
  assert.match(watchdog, /AEGP/);
  assert.match(watchdog, /输入文件/);
  assert.match(scheduler, /Severity -eq "warning"/);
});

test("效果渲染器按 2×2 分批，内置与第三方插件不混在同一批", () => {
  const jsx = read("tools/run_plugin_preview.jsx");
  const gen = read("cep/com.dreamengine.panel/engine/previewgen.jsx");

  assert.match(jsx, /BATCH_SIZE = conf\.contactSheet\.effectsPerSheet/);
  assert.match(jsx, /singleCell: false/);
  assert.match(jsx, /gridColumns: conf\.contactSheet\.columns/);
  assert.match(jsx, /gridRows: /);
  assert.match(jsx, /sameRenderKind/);
  assert.match(jsx, /plugin_active_batch\.tsv/);
  assert.match(jsx, /forceSingles/);
  assert.match(jsx, /function renderSingle/);
  assert.doesNotMatch(jsx, /Start-Sleep -Seconds 4; Stop-Process -Name AfterFX -Force/);
  assert.match(jsx, /app\.project\.close\(CloseOptions\.DO_NOT_SAVE_CHANGES\)/);
  assert.match(gen, /options\.gridColumns/);
  assert.match(gen, /options\.gridRows/);
});

test("插件预览统一使用 24fps，并淘汰帧文件不完整的旧索引", () => {
  const builder = read("tools/build_png_template.jsx");
  const gen = read("cep/com.dreamengine.panel/engine/previewgen.jsx");
  const jsx = read("tools/run_plugin_preview.jsx");
  assert.match(builder, /addComp\("DE_RENDER_TARGET",\s*720,\s*720,\s*1,\s*1,\s*24\)/);
  assert.match(gen, /grid\.frameRate\s*=\s*CELL_FPS/);
  assert.match(gen, /files\.length\s*===\s*frames/);
  assert.match(jsx, /function entryFramesExist/);
  assert.match(jsx, /function manifestWebpForMatchName/);
  assert.match(jsx, /manifestWebpForMatchName\(entry\.matchName\)/);
  assert.match(jsx, /entry\.webpSrc/);
  assert.match(jsx, /PS\.mergePreviewFields/);
  assert.match(jsx, /currentManifest/);
  assert.match(jsx, /if \(!entryFramesExist\(entries\[ve\]\)\)/);
  const lib = read("cep/com.dreamengine.panel/js/library.js");
  assert.match(lib, /var stillIndex = undefined/);
  assert.match(lib, /Math\.floor\(frameCount \/ 2\)/);
});

test("插件效果复用随包 AEP 的 PNG 渲染队列，不依赖系统输出模板", () => {
  const jsx = read("tools/run_plugin_preview.jsx");
  const gen = read("cep/com.dreamengine.panel/engine/previewgen.jsx");
  const scheduler = read("tools/generate_plugin_effects.ps1");

  assert.match(jsx, /plugin_render_template_path\.txt/);
  assert.match(jsx, /function openRenderTemplate/);
  assert.match(jsx, /template_render_\[####\]\.png/);
  assert.match(jsx, /targetComp: renderTemplateComp/);
  assert.match(jsx, /targetQueueItem: renderTemplateQueue/);
  assert.match(gen, /options\.targetComp/);
  assert.match(gen, /options\.targetQueueItem/);
  assert.match(gen, /targetQueueItem\.duplicate\(\)/);
  assert.match(gen, /queueItem\.render = true/);
  assert.ok(
    gen.indexOf("queueItem.render = true") < gen.indexOf("outputModule.file ="),
    "复用已完成的模板队列时，必须先 requeue 再写输出路径",
  );
  assert.match(scheduler, /DreamEnginePNG\.aep/);
});

test("随包 AEP 不包含任何外部文件素材，避免打开时弹缺失文件", () => {
  const bytes = readFileSync(resolve(ROOT, "tools/DreamEnginePNG.aep"));
  const audit = JSON.parse(readFileSync(resolve(ROOT, "tools/DreamEnginePNG.audit.json"), "utf8"));
  assert.equal(
    bytes.includes(Buffer.from("Pin sspc png!")),
    false,
    "DreamEnginePNG.aep 仍包含导入的 PNG 文件素材",
  );
  assert.equal(
    bytes.includes(Buffer.from("template_render_0000.png")),
    false,
    "DreamEnginePNG.aep 仍引用旧开发机模板 PNG",
  );
  assert.equal(
    bytes.includes(Buffer.from("C:\\\\Users\\\\")),
    false,
    "DreamEnginePNG.aep 仍保存了用户目录下的绝对输出路径",
  );
  assert.deepEqual(
    audit.items.filter((item) => item.sourcePath),
    [],
    "DreamEnginePNG.aep 仍包含外部素材路径",
  );
  assert.deepEqual(
    audit.items.filter((item) => item.type === "comp").map((item) => item.name),
    ["DE_RENDER_TARGET"],
  );
  assert.equal(audit.compFrameRate, 24);
});

test("依赖外部渲染器的效果（CINEMA 4D / Element 3D）不参与预览", () => {
  // 实测：一渲染 AE 就挂住（进程还在但永远不返回），会拖死整批
  assert.equal(view.isPoorPreviewTarget({ matchName: "CINEMA 4D Effect", category: "CINEMA 4D" }), true);
  assert.equal(view.isPoorPreviewTarget({ matchName: "Element 3D Comp", category: "Element 3D" }), true);
  assert.equal(view.isPoorPreviewTarget({ matchName: "ADBE Glo2", category: "风格化" }), false);
});

test("插件保持默认参数、不人为加动画（AE 2021 上一写就坏）", () => {
  const src = read("cep/com.dreamengine.panel/engine/recipe.jsx");
  const code = src
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, "").replace(/^\s*\*.*$/, ""))
    .join("\n");
  // 不写参数：实测写插件参数会让整条效果报「Error 的对象」渲不出来
  assert.match(code, /function tunePlugin\(/);
  assert.match(code, /trace\("tune\|skip\|"/);
  assert.doesNotMatch(code, /setNumberSafely\(main\.prop, target\)/);
  // 不人为打关键帧（打关键帧同样是写参数）
  assert.match(code, /trace\("animate\|skip_for_plugin"\)/);
  // 「按作用分档」的判断逻辑保留着，等将来能安全写参数时直接启用
  assert.match(code, /var ratio = 0\.15;/);
  assert.match(code, /ratio = 0\.7;/);
  assert.match(code, /function pluginMainParam\(/);
  // 附属模块不碰
  assert.match(code, /isPluginAuxiliary\(name\)/);
});

test("效果预览固定 24 帧、24fps、1 秒", () => {
  const pick = read("tools/pick_plugin_candidates.mjs");
  assert.doesNotMatch(pick, /const frames = 1;/);
  assert.match(pick, /frameCount/);
  const jsx = read("tools/run_plugin_preview.jsx");
  assert.match(jsx, /var previewFrames = AEV_PreviewGen\.config\(\)\.animatedPreview\.frameCount \|\| 24;/);
  assert.match(jsx, /frames: previewFrames/);
  assert.match(jsx, /fps:\s*24/);
  assert.match(jsx, /duration:\s*1/);
});

test("来源下拉包含「其它插件」", () => {
  assert.match(read("cep/com.dreamengine.panel/index.html"), /value="其它插件"/);
});

/* ---------- 6. 候选名单端到端 ---------- */

test("候选名单不含内置、按包轮转、遵守黑名单与限流", () => {
  const tmp = resolve(ROOT, ".workbuddy/tmp/plugin-test");
  mkdirSync(tmp, { recursive: true });
  const out = resolve(tmp, "batch.tsv");
  const black = resolve(tmp, "blacklist.tsv");
  // 用一份空的运行时索引：真实目录里的插件早就被挑完了（候选会随进度变化），
  // 测试不能依赖现场状态。
  const fakeData = resolve(tmp, "data");
  mkdirSync(fakeData, { recursive: true });
  writeFileSync(resolve(fakeData, "manifest.json"), '{"items":[]}', "utf8");
  const tool = resolve(ROOT, "tools/pick_plugin_candidates.mjs");
  const runTool = (extra) => execFileSync(process.execPath, [
    tool, "--limit", "6", "--out", out, "--blacklist", black, "--data", fakeData
  ].concat(extra), { encoding: "utf8", cwd: ROOT });

  if (existsSync(black)) unlinkSync(black);
  runTool([]);
  const rows = readFileSync(out, "utf8").split(/\r?\n/)
    .filter((l) => l && l.charAt(0) !== "#")
    .map((l) => l.split("\t"));
  assert.equal(rows.length, 6, "应挑出 6 条");
  for (const row of rows) {
    assert.equal(view.isBuiltinEffect({ matchName: row[0] }), false, row[0] + " 不能是内置");
    assert.ok(Number(row[1]) > 0, "帧数必须为正");
    assert.ok(row[2], "必须带插件包");
  }
  assert.ok(new Set(rows.map((r) => r[2])).size >= 3, "首批应覆盖多个插件包");

  // 把第一条拉黑后重挑，它不应再出现
  writeFileSync(black, "matchName\treason\n" + rows[0][0] + "\tcrash\n", "utf8");
  runTool([]);
  const second = readFileSync(out, "utf8").split(/\r?\n/)
    .filter((l) => l && l.charAt(0) !== "#")
    .map((l) => l.split("\t")[0]);
  assert.ok(!second.includes(rows[0][0]), "黑名单条目不应再被挑出");
  unlinkSync(out);
  unlinkSync(black);
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
