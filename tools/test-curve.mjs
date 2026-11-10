#!/usr/bin/env node
/* ============================================================
 * test-curve.mjs —— M4 曲线编辑的回归
 *
 * 两类断言：
 *   1. 数学：用真实数值验证换算恒等式（线性/缓动/极值/往返/路径）
 *   2. 契约：把「踩过的坑」固化成源码断言
 *      · 写回必须包 undo 组（且成对）
 *      · 写之前必须关掉自动贝塞尔（否则 AE 重算把手，白写）
 *      · 绝不写 comp.selectedLayers（AE 2021 会崩）
 *      · 拖拽过程中不许过桥，松手才写（否则每个 mousemove 一次 evalScript）
 *      · 面板与引擎的预设 id 必须一一对应
 *
 * 用法：node tools/test-curve.mjs
 * ============================================================ */

import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");
const ENGINE = "cep/com.dreamengine.panel/engine";

function codeOf(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/, ""))
    .join("\n");
}

/** 按 AE 侧的顺序加载：先纯数学，再图模型，最后读写层 */
function loadEngine() {
  const context = vm.createContext({});
  vm.runInContext(read(`${ENGINE}/curve_math.js`), context, { filename: "curve_math.js" });
  vm.runInContext(read(`${ENGINE}/curve_graph.js`), context, { filename: "curve_graph.js" });
  vm.runInContext(read(`${ENGINE}/curvelib.jsx`), context, { filename: "curvelib.jsx" });
  return { C: context.AEV_Curve, M: context.AEV_CurveMath, G: context.AEV_CurveGraph, context };
}

/** 只加载纯图模块（浏览器与 ExtendScript 共用的那一份） */
function loadGraph() {
  const context = vm.createContext({});
  vm.runInContext(read(`${ENGINE}/curve_math.js`), context, { filename: "curve_math.js" });
  vm.runInContext(read(`${ENGINE}/curve_graph.js`), context, { filename: "curve_graph.js" });
  return context.AEV_CurveGraph;
}

const { C, M } = loadEngine();

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const EPS = 1e-6;

function key(t, v, extra) {
  const dims = v.length;
  const fill = (n) => v.map(() => n);
  return Object.assign({
    t, v,
    tin: 2, tout: 2,
    os: fill(0), oi: fill(33.33),
    is: fill(0), ii: fill(33.33),
    ot: fill(0), it: fill(0)
  }, extra || {});
}

/* ============================================================
 * 一、数学恒等式
 * ============================================================ */

test("线性段：采样值等于等分插值", () => {
  const keys = [
    key(0, [0], { tin: 1, tout: 1, os: [100], is: [100] }),
    key(1, [100], { tin: 1, tout: 1, os: [100], is: [100] })
  ];
  const seg = C.segmentOf(keys, 0);
  for (const [t, expect] of [[0, 0], [0.25, 25], [0.5, 50], [0.75, 75], [1, 100]]) {
    assert.ok(Math.abs(C.sampleValue(seg, 0, t) - expect) < 1e-6, `t=${t}`);
  }
});

test("缓动段（speed 0 / influence 33.33）：端点准确、中点 50、单调", () => {
  const keys = [key(0, [0]), key(1, [100])];
  const seg = C.segmentOf(keys, 0);
  assert.ok(Math.abs(C.sampleValue(seg, 0, 0)) < EPS);
  assert.ok(Math.abs(C.sampleValue(seg, 0, 1) - 100) < EPS);
  assert.ok(Math.abs(C.sampleValue(seg, 0, 0.5) - 50) < 1e-4);
  let prev = -1;
  for (let i = 0; i <= 40; i++) {
    const v = C.sampleValue(seg, 0, i / 40);
    assert.ok(v >= prev - 1e-9, `非单调于 i=${i}`);
    prev = v;
  }
});

test("缓动曲线对称：v(0.25) + v(0.75) = 100", () => {
  const seg = C.segmentOf([key(0, [0]), key(1, [100])], 0);
  const a = C.sampleValue(seg, 0, 0.25);
  const b = C.sampleValue(seg, 0, 1 - 0.25);
  assert.ok(Math.abs(a + b - 100) < 1e-4, `${a} + ${b}`);
  // 缓入缓出的标志：25% 处明显慢于线性（< 25）
  assert.ok(a < 25, "25% 处的值应低于线性的 25");
});

test("influence=100：把手铺满区间，中点仍是 50", () => {
  const keys = [
    key(0, [0], { oi: [100] }),
    key(1, [100], { ii: [100] })
  ];
  const seg = C.segmentOf(keys, 0);
  assert.ok(Math.abs(C.sampleValue(seg, 0, 0.5) - 50) < 1e-4);
  // 端点斜率为 0
  assert.ok(Math.abs(C.speedAt(seg, 0, 1e-6)) < 1e-2);
});

test("定格插值：区间内值恒为起点值", () => {
  const keys = [
    key(0, [10], { tout: 3 }),
    key(1, [90])
  ];
  const seg = C.segmentOf(keys, 0);
  assert.equal(C.sampleValue(seg, 0, 0.3), 10);
  assert.equal(C.sampleValue(seg, 0, 0.99), 10);
});

test("solveU 反解：bezier(x(u)) = 目标 x", () => {
  const p0 = 0, p1 = 0.2, p2 = 0.85, p3 = 1;
  for (const x of [0, 0.1, 0.33, 0.5, 0.77, 1]) {
    const u = C.solveU(p0, p1, p2, p3, x);
    assert.ok(Math.abs(M.bezier1(p0, p1, p2, p3, u) - x) < 1e-6, `x=${x}`);
  }
});

test("把手 → ease 往返：把把手放回原位能还原 influence 与斜率", () => {
  const keys = [key(0, [0], { oi: [40] }), key(1, [100], { ii: [60] })];
  const seg = C.segmentOf(keys, 0);
  const h = M.handles(seg, 0);
  const out = C.easeFromHandle(seg, "out", 0, h.p1.x, h.p1.y);
  assert.ok(Math.abs(out.inf - 40) < 1e-3, `inf=${out.inf}`);
  assert.ok(Math.abs(out.m - seg.mOut) < 1e-6, `m=${out.m}`);
  const inn = C.easeFromHandle(seg, "in", 0, h.p2.x, h.p2.y);
  assert.ok(Math.abs(inn.inf - 60) < 1e-3, `infIn=${inn.inf}`);
});

test("influence 钳位：拖到区间外不会产生非单调曲线", () => {
  const seg = C.segmentOf([key(0, [0]), key(1, [100])], 0);
  const far = C.easeFromHandle(seg, "out", 0, seg.tB + 5, 0);
  assert.equal(far.inf, M.MAX_INFLUENCE);
  const near = C.easeFromHandle(seg, "out", 0, seg.tA - 5, 0);
  assert.equal(near.inf, M.MIN_INFLUENCE);
});

test("线性段的速度恒等于弦斜率", () => {
  const seg = C.segmentOf([
    key(0, [0], { tin: 1, tout: 1, os: [50], is: [50] }),
    key(2, [100], { tin: 1, tout: 1 })
  ], 0);
  for (const t of [0.1, 0.5, 1.9]) {
    assert.ok(Math.abs(C.speedAt(seg, 0, t) - 50) < 1e-6);
  }
});

test("多维：m 由主导维（弦斜率最大者）决定，各维同一条缓动", () => {
  const keys = [
    key(0, [0, 0], { os: [0, 0], is: [0, 0] }),
    key(2, [200, -50], { os: [0, 0], is: [0, 0] })
  ];
  const seg = C.segmentOf(keys, 0);
  assert.equal(seg.dominant, 0, "X 维弦斜率（100/s）大于 Y 维（-25/s），应为主导维");
  assert.equal(seg.mOut, 0);
  // X/Y 在 50% 处应同为各自的 50%
  assert.ok(Math.abs(C.sampleValue(seg, 0, 1) - 100) < 1e-4);
  assert.ok(Math.abs(C.sampleValue(seg, 1, 1) + 25) < 1e-4);
});

test("空间路径：切线为零是直线，给切线则弯曲", () => {
  const straight = C.segmentOf([
    key(0, [0, 0]), key(1, [100, 0])
  ], 0);
  const midStraight = C.pathPoint(straight, 0.5);
  assert.ok(Math.abs(midStraight[0] - 50) < 1e-6);
  assert.ok(Math.abs(midStraight[1]) < 1e-6);

  const curved = C.segmentOf([
    key(0, [0, 0], { ot: [0, 100] }),
    key(1, [100, 0], { it: [0, 100] })
  ], 0);
  const midCurved = C.pathPoint(curved, 0.5);
  // 两端切线都朝 +Y，中间必然鼓起来
  assert.ok(midCurved[1] > 50, `midY=${midCurved[1]}`);
});

test("路径与时间互不串数据：改 ease 不改路径形状", () => {
  const keys = [
    key(0, [0, 0], { ot: [0, 80] }),
    key(1, [100, 0], { it: [0, 80] })
  ];
  const a = C.segmentOf(keys, 0);
  const before = C.pathPoint(a, 0.5);
  keys[0].oi = [90];
  keys[1].ii = [90];
  const b = C.segmentOf(keys, 0);
  const after = C.pathPoint(b, 0.5);
  assert.ok(Math.abs(before[1] - after[1]) < 1e-9, "路径形状不该被 ease 影响");
});

test("一维速度是带符号的值速度：正 speed 在下降段会过冲", () => {
  // 实机教训：100→30 的段上设 speed=+100 / influence=50，AE 会先冲高到 ~110。
  // 如果按「模长」算基准，符号会被吃掉，曲线反而往下走（偏差 41px）。
  const keys = [
    key(0, [100], { os: [100], oi: [50], is: [100], ii: [50] }),
    key(1, [30], { os: [0], oi: [33.33], is: [0], ii: [33.33] })
  ];
  const seg = C.segmentOf(keys, 0);
  assert.ok(seg.mOut < 0, "下降段的正 speed 应得到负斜率倍率，实际 " + seg.mOut);
  const v = C.sampleValue(seg, 0, 0.25);
  assert.ok(v > 100, "应该向上过冲，实际 " + v);
});

test("空间多维：速度按路径模长解释", () => {
  const keys = [
    key(0, [100, 900], { os: [400, 400], oi: [60, 60], sp: true }),
    key(1, [900, 200], { os: [0, 0], oi: [33.33, 33.33], sp: true })
  ];
  const seg = C.segmentOf(keys, 0);
  const chordMag = Math.sqrt(800 * 800 + (-700) * (-700)) / 1;
  assert.ok(Math.abs(seg.chordMag - chordMag) < 1e-6, "模长速度算错");
  assert.ok(Math.abs(seg.mOut - 400 / chordMag) < 1e-6, "m 应按模长归一，实际 " + seg.mOut);
});

test("非空间多维（缩放）按主导维的弦解释，不是模长", () => {
  // 实机矩阵：缩放是 [x,y,z]，AE 要求 ease 数组长度 3；各维有自己的 speed，
  // 所以基准只能是某一维的弦，不能是模长（否则读出来的 m 与写回去的对不上）。
  const keys = [
    key(0, [100, 900], { os: [400, 400], oi: [60, 60] }),
    key(1, [900, 200], { os: [0, 0], oi: [33.33, 33.33] })
  ];
  const seg = C.segmentOf(keys, 0);
  assert.equal(seg.spatial, false, "样例不该被当成空间属性");
  // 主导维是 x（800/1 > 700/1）
  assert.equal(seg.dominant, 0, "主导维应为 x");
  assert.ok(Math.abs(seg.mOut - 400 / 800) < 1e-6, "非空间多维应按主导维弦归一，实际 " + seg.mOut);
});

test("空间路径按弧长推进，而不是按贝塞尔参数", () => {
  // 实机对照：参数法偏差 70px，弧长法 3.5px。这里造一条明显弯曲的路径，
  // 断言「进度 0.5」取到的点不等于「参数 0.5」的点。
  const keys = [
    // 两端切线长度不等，弧长中点才会与参数中点错开（对称路径两者相等）
    key(0, [0, 0], { os: [0, 0], oi: [33.33, 33.33], ot: [0, 800] }),
    key(1, [1000, 0], { os: [0, 0], oi: [33.33, 33.33], it: [0, 100] })
  ];
  const seg = C.segmentOf(keys, 0);
  assert.equal(seg.spatial, false, "样例没带 sp 标记时应按非空间处理");
  seg.spatial = true; // 手工标记：这个用例就是要测空间分支
  const u = M.uAtProgress ? M.uAtProgress(seg, 0.5) : 0.5;
  const byArc = M.pathPoint(seg, u)[1];
  const byParam = M.pathPoint(seg, 0.5)[1];
  assert.notEqual(byArc.toFixed(3), byParam.toFixed(3), "弧长与参数应该不同");
  const v = C.sampleValue(seg, 1, 0.5);
  assert.ok(Math.abs(v - byArc) < 1e-6, "采样应走弧长映射");
});

test("快照里一维值必须是数组，且带 spatial / ease 长度字段", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /function valueArr\(/, "缺少 valueArr");
  assert.match(code, /jfield\("v", jnumArr\(valueArr\(value\)\)\)/, "快照的 v 没有数组化");
  assert.match(code, /jfield\("sp", jbool/, "快照缺少 spatial 标记");
  assert.match(code, /jfield\("ne", String\(/, "快照缺少 ease 数组长度");
});

test("插值枚举按实机值映射（6612 线性 / 6613 贝塞尔 / 6614 定格）", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /ENUM_LINEAR = 6612/);
  assert.match(code, /ENUM_BEZIER = 6613/);
  assert.match(code, /ENUM_HOLD = 6614/);
  // 快照与写回都必须过 typeCode，不能把裸枚举塞进模型
  assert.match(code, /jfield\("tin", String\(typeCode\(/);
  assert.match(code, /jfield\("tout", String\(typeCode\(/);
  assert.match(code, /tin: typeCode\(prop\.keyInInterpolationType/);
});

test("多维 ease 只写 1 个元素，空间切线写 3 个元素", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  // AE 2021 实测：多维 ease 数组长度 >1 直接报「值数组没有 1 元素」
  assert.match(code, /return \[makeEase\(/, "buildEase 应只返回 1 个 KeyframeEase");
  assert.doesNotMatch(code, /for \(d = 0; d < dims; d\+\+\) \{\s*out\.push\(makeEase/,
    "buildEase 仍在按维度展开");
  // 空间切线对 2D 属性也要求 3 个元素
  assert.match(code, /var n = dims > 3 \? dims : 3;/, "切线数组没有补到 3");
});

/* ============================================================
 * 二、引擎源码契约
 * ============================================================ */

test("写回必须包在 beginUndoGroup / endUndoGroup 里", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /app\.beginUndoGroup\(/);
  assert.match(code, /app\.endUndoGroup\(\)/);
  // 一次拖拽 = 一次撤销：整批写在同一组内
  const start = code.indexOf("function applyText(");
  const end = code.indexOf("return {", start);
  const body = code.slice(start, end);
  assert.match(body, /beginUndoGroup/);
  assert.match(body, /applyTextRaw/);
  assert.match(body, /endUndoGroup/);
});

test("写 ease 前先关掉自动贝塞尔（否则 AE 会重算把手）", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  const writer = code.slice(code.indexOf("function writeSide("), code.indexOf("function writeLinear("));
  assert.match(writer, /setTemporalAutoBezierAtKey\(aeIndex, false\)/);
  assert.match(writer, /setTemporalEaseAtKey\(aeIndex/);
  // 线性/定格关键帧不吃 ease，必须先改插值类型
  assert.match(writer, /setInterpolationTypeAtKey/);
});

test("roving 关键帧跳过写 ease（时间由 AE 排布）", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /keyRoving/);
  assert.match(code, /return "roving"/);
});

test("绝不写 comp.selectedLayers；不用会崩的 API", () => {
  for (const file of [`${ENGINE}/curvelib.jsx`, "cep/com.dreamengine.panel/js/curve.js"]) {
    const code = codeOf(read(file));
    assert.doesNotMatch(code, /selectedLayers\s*=/, `${file} 给 selectedLayers 赋值了`);
    assert.doesNotMatch(code, /getItemByName/, `${file} 用了 getItemByName`);
    assert.doesNotMatch(code, /app\.applyPreset/, `${file} 用了 app.applyPreset`);
  }
});

test("只收数值属性：路径/文本吃不进 ease，不能进快照", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.ok(code.includes("function isNumericValue("), "缺少 isNumericValue");
  assert.ok(code.includes("if (typeof v === \"number\") return true;"), "没把裸数字算数值");
  assert.ok(code.includes("if (!isNumericValue(prop)) {"), "push 没有过滤非数值属性");
  // 过滤要计数，面板才能区分「没选中」与「选中的不支持缓动」
  assert.ok(code.includes("filtered++;"), "没有统计被过滤的属性");
  assert.ok(code.includes('jfield("filtered", String(lastFiltered))'), "快照没带 filtered");
});

test("选中的属性不支持缓动时，不再退回「遍历整层」", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  // fallback 的判据必须是「有没有选中」，不是「收上来几条」
  assert.ok(code.includes("var hadSelection = false;"), "缺少 hadSelection");
  assert.ok(code.includes("if (sp && sp.length > 0) {"), "没按选中数量判断");
  assert.ok(!/if \(!list\.length\) \{\s*var layers/.test(code),
    "还在用「list 为空」当 fallback 判据（会把用户没选的属性一起改掉）");
});

test("单条写失败降级成跳过，不许拖垮整批", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  const body = code.slice(code.indexOf("function writeSide("), code.indexOf("function writeLinear("));
  assert.ok(body.includes("try {"), "writeSide 里没有 try");
  assert.ok(/try \{\s*prop\.setTemporalEaseAtKey\(aeIndex, inArr, outArr\);\s*\} catch \(e5\) \{[\s\S]*?return "failed";/.test(body),
    "setTemporalEaseAtKey 没有包 try/catch，抛出来就是整批 write_failed");
  // 异常文本必须留下来，否则面板只能报一个 "failed" 代号
  assert.ok(body.includes("lastWriteError ="), "写失败时没有记下 AE 的原话");
});

test("写入被拒时把 AE 的原始异常与属性位置一起报出来", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const send = code.slice(code.indexOf("function send("), code.indexOf("function skipNote("));
  assert.ok(send.includes("data.detail"), "没有显示 AE 的异常详情");
  assert.ok(send.includes("shortLoc(data.loc)"), "没有指出是哪条属性");
  // 一条都没写成时按失败处理，不能显示「已应用 0 处」
  assert.ok(send.includes("if (!applied)"), "全部跳过时没有按失败处理");
});

test("跳过原因按类别归并成一句人话", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const note = code.slice(code.indexOf("function skipNote("), code.indexOf("function describeScope("));
  for (const key of [
    "failed", "roving", "edge", "loc_missing", "key_out_of_range",
    "selection_needs_two", "selection_unavailable", "metadata_corrupt",
    "graph_invalid", "graph_block_invalid", "key_create_failed",
    "ease_write_failed", "metadata_write_failed", "endpoint_missing", "zero_duration"
  ]) {
    assert.ok(note.includes("counts." + key), "没有归类 " + key);
  }
  assert.ok(note.includes("不支持缓动"), "failed 没有说明是「不支持缓动」");
  // 原生中间键被拒是真正常见的失败，必须单独成句，否则界面会退回
  // 「属性不支持缓动」把人引到错误方向
  assert.ok(note.includes("counts.native_intermediate"), "没有归类 native_intermediate");
  assert.ok(note.includes("中间键"), "native_intermediate 没有说明是用户自己的中间键");
});

test("乐观并发：expect 指纹不匹配时不写，返回 conflict", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /kind === "expect"/);
  assert.match(code, /jfield\("status", jstr\("conflict"\)\)/);
  // 冲突检查必须在写循环之前
  const checkAt = code.indexOf('jstr("conflict")');
  const writeAt = code.indexOf("var applied = 0;");
  assert.ok(checkAt > 0 && checkAt < writeAt, "冲突检查必须早于任何写入");
  // force 由面板显式下发（用户点「覆盖」）
  assert.match(code, /kind === "force"/);
});

test("快照字段齐全：面板画图需要的东西一个不少", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  for (const field of ["loc", "name", "matchName", "vt", "dims", "spatial", "sep", "n", "sig", "keys"]) {
    assert.match(code, new RegExp(`jfield\\("${field}"`), `快照缺少 ${field}`);
  }
  for (const field of ["os", "oi", "is", "ii", "ot", "it", "ab", "co", "rv"]) {
    assert.match(code, new RegExp(`jfield\\("${field}"`), `关键帧缺少 ${field}`);
  }
});

test("引擎拆分：curvelib 依赖 curve_math，缺了要明确报错", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.match(code, /typeof AEV_CurveMath === "undefined"/);
  assert.match(code, /需要先加载 engine\/curve_math\.js/);

  // 真跑一次：不给数学模块，必须抛错而不是静默产出半个模块
  const context = vm.createContext({});
  assert.throws(() => {
    vm.runInContext(read(`${ENGINE}/curvelib.jsx`), context, { filename: "curvelib.jsx" });
  }, /curve_math/);
});

test("面板缓动库是合法的 cubic-bezier，且覆盖常用族", () => {
  const panelSrc = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const block = panelSrc.slice(panelSrc.indexOf("var PRESETS = ["), panelSrc.indexOf("var deps ="));
  const rows = [];
  const parts = block.split("{").slice(1);
  for (const part of parts) {
    const idAt = part.indexOf('id: "');
    const bAt = part.indexOf("b: [");
    if (idAt < 0 || bAt < 0) continue;
    const id = part.slice(idAt + 5, part.indexOf('"', idAt + 5));
    const b = part.slice(bAt + 4, part.indexOf("]", bAt)).split(",").map(Number);
    rows.push({ id, b });
  }
  assert.ok(rows.length >= 12, "预设数量不足：" + rows.length);
  const ids = rows.map((r) => r.id);
  for (const need of ["linear", "ease", "ease-in", "ease-out", "ease-in-out", "cubic-in", "back-out"]) {
    assert.ok(ids.includes(need), "缺少预设 " + need);
  }
  for (const r of rows) {
    assert.equal(r.b.length, 4, r.id + " 不是四元组");
    assert.ok(r.b[0] >= 0 && r.b[0] <= 1, r.id + " 的 x1 越界：" + r.b[0]);
    assert.ok(r.b[2] >= 0 && r.b[2] <= 1, r.id + " 的 x2 越界：" + r.b[2]);
    assert.ok(Math.abs(r.b[1]) <= 3 && Math.abs(r.b[3]) <= 3, r.id + " 的 y 超出可表达范围");
  }
  assert.ok(panelSrc.includes("function bezierToEase("), "缺少 bezierToEase");
  assert.ok(panelSrc.includes("function buildText("), "缺少 buildText（预设与拖拽共用的写回出口）");
});

test("Flow 布局：曲线 + 应用 + 预设网格，没有「读取选中」入口", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  for (const id of [
    "curveStage", "curveCanvas", "curveReadout", "curveApply",
    "curvePresetSaveOpen", "curvePresets"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "缺少 " + id);
  }
  // 手动读取与属性下拉都取消了：读 AE 只发生在按「应用」时
  for (const gone of ["btnCurveRead", "curveProp", "curvePreset", "curveDim"]) {
    assert.ok(!html.includes('id="' + gone + '"'), "不该再有 " + gone);
  }
  const css = read("cep/com.dreamengine.panel/css/style.css");
  for (const sel of [
    ".curve-action-row", ".curve-apply", ".curve-save-open",
    ".curve-presets", ".preset-chip", ".curve-readout"
  ]) {
    assert.ok(css.includes(sel), "缺少样式 " + sel);
  }
});

test("曲线是常驻模板：进入视图不读 AE", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const enter = code.slice(code.indexOf("function enter("), code.indexOf("function snapshot("));
  assert.ok(enter.length > 20, "没找到 enter");
  assert.ok(!enter.includes("snapshotJson"), "enter() 还在读快照");
  assert.ok(!enter.includes("engine("), "enter() 还在过桥");
  // 读快照只应出现在 apply / refreshSnap / applyTool（换键与冻结同样是
  // 用户主动点一次才读一次 AE），进入视图与拖拽都不许读。
  assert.equal((code.match(/snapshotJson/g) || []).length, 3,
    "snapshotJson 只应出现在 apply、refreshSnap 与 applyTool 各一次");
});

test("值图只有一组把手，拖拽只改本地曲线、绝不过桥", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  for (const fn of ["handleAt", "applyDrag", "drawHandles", "bezierPoint"]) {
    assert.ok(code.includes("function " + fn + "("), "缺少 " + fn);
  }
  const drag = code.slice(code.indexOf("function applyDrag("), code.indexOf("function onMouseUp("));
  assert.ok(drag.length > 100, "没找到 applyDrag");
  assert.ok(!drag.includes("send("), "拖拽里调用了写回");
  assert.ok(!drag.includes("engine("), "拖拽里过了桥");
  assert.ok(drag.includes("st.curve.x1 = nx"), "拖拽没有更新本地曲线");
  // 松手也不写：写入只由「应用」触发
  const up = code.slice(code.indexOf("function onMouseUp("), code.indexOf("function onKeyDown("));
  assert.ok(!up.includes("send("), "松手还在写回");
});

test("应用时才读快照：expect + out/in 覆盖每条属性的每一段", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const build = code.slice(code.indexOf("function buildText("), code.indexOf("function apply("));
  assert.ok(build.includes('"expect') && build.includes("p.loc") && build.includes("p.sig"), "缺少 expect 行");
  assert.ok(build.includes('["out", p.loc, String(s)'), "缺少 out 侧");
  assert.ok(build.includes('["in", p.loc, String(s + 1)'), "缺少 in 侧");
  assert.ok(build.includes("segs++"), "没有累计段数");
  assert.ok(build.includes("keys.length < 2"), "不足两把关键帧的属性没有跳过");

  const apply = code.slice(code.indexOf("function apply("), code.indexOf("function send("));
  assert.ok(apply.includes('engine("AEV_Curve.snapshotJson()"'), "apply 没有读快照");
  assert.ok(apply.includes("st.snap = data"), "apply 没有留下快照");
  assert.ok(apply.includes("buildText(data.props, st.curve)"), "apply 没有用模板曲线");

  const send = code.slice(code.indexOf("function send("), code.indexOf("function describeScope("));
  assert.ok(send.includes("AEV_Curve.applyText"), "send 没调写回");
  assert.ok(send.includes("refreshSnap()"), "写成功后没有重读对齐");
});

test("预设以曲线缩略图呈现，点选即换模板", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  for (const fn of ["renderPresets", "makeChip", "drawChip", "selectPreset"]) {
    assert.ok(code.includes("function " + fn + "("), "缺少 " + fn);
  }
  // 缩略图必须真的画曲线，不能只写文字
  const chip = code.slice(code.indexOf("function drawChip("), code.indexOf("function selectPreset("));
  assert.ok(chip.includes("bezierPoint("), "两点缩略图没有按贝塞尔采样");
  assert.ok(chip.includes("AEV_CurveGraph.sample("), "多点缩略图没有按图采样");
  assert.ok(chip.includes("ctx.stroke()"), "缩略图没有描边");
  // 回弹族会跑出 0..1，缩略图要按实际范围取景
  assert.ok(/\(hi - lo\)/.test(chip), "缩略图没有按 y 范围取景");

  // 两类预设：点中要各自切到对应模式
  const sel = code.slice(code.indexOf("function selectPreset("), code.indexOf("function updateReadout("));
  assert.ok(sel.includes("st.curve = clampCurve({ x1: b[0]"), "点两点预设没有换模板");
  assert.ok(sel.includes("st.graph = g"), "点多点预设没有把图装进编辑器");
  assert.ok(sel.includes('switchGraphMode("multi")'), "点多点预设没有自动切到多点模式");
  assert.ok(sel.includes('switchGraphMode("two")'), "点两点预设没有自动切回两点模式");
  // 顺序：必须先装图再切模式，否则 switchGraphMode 会拿 st.curve 把图盖掉
  assert.ok(sel.indexOf("st.graph = g") < sel.indexOf('switchGraphMode("multi")'),
    "装图必须早于切模式");
  assert.ok(sel.includes("st.preset = id"), "点预设没有记选中态");

  /* 角标类名不能撞预设库的 .preset-badge（那边是「静态/动态」标记） */
  const chipFn = code.slice(code.indexOf("function makeChip("), code.indexOf("function startPresetHold("));
  assert.ok(chipFn.includes("curve-preset-badge"), "多点角标应使用独立类名");
  assert.ok(!/className = "preset-badge"/.test(chipFn), "角标类名与预设库冲突");
  // 手动拖过之后必须取消预设高亮，否则出现「高亮着缓动、曲线已变」的假象
  const drag = code.slice(code.indexOf("function applyDrag("), code.indexOf("function onMouseUp("));
  assert.ok(drag.includes('st.preset = ""'), "手动拖拽没有取消预设高亮");
});

test("窄列预设名称允许两行，不靠省略号吞字", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  const chipText = css.slice(css.indexOf(".preset-chip .preset-name"), css.indexOf(".preset-chip:hover"));
  assert.match(chipText, /white-space:\s*normal/);
  assert.match(chipText, /-webkit-line-clamp:\s*2/);
  assert.match(chipText, /overflow-wrap:\s*anywhere|word-break:\s*break-word/);
  assert.match(css, /\.curve-action-row\s*\{/);
  assert.match(css, /\.curve-save-open\s*\{/);
});

test("curve buttons share the material category interaction", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  const marker = "/* Curve page buttons: same interaction as material categories. */";
  const start = css.indexOf(marker);
  assert.ok(start >= 0, "missing shared curve button interaction styles");

  const rules = css.slice(start, css.indexOf("@media (max-width: 620px)", start));
  for (const selector of [
    ".mode-box-btn",
    ".mode-item",
    ".curve-action-btn",
    ".curve-tool-button",
    ".curve-toolbar-arrow",
    ".preset-chip",
    ".action-button"
  ]) {
    assert.ok(rules.includes(".curve-view " + selector), "interaction missing " + selector);
  }
  for (const selected of [
    ".curve-tool-button.active",
    ".mode-item.active",
    ".preset-chip.active"
  ]) {
    assert.ok(rules.includes(".curve-view " + selected), "selected feedback missing " + selected);
  }
  assert.match(rules, /background(?:-color)?:\s*#111a4d/i);
  assert.match(rules, /transform:\s*translate\(1px,\s*-1px\)/);
  assert.match(rules, /transform:\s*scale\(0\.99\)/);
  assert.match(rules, /0\.3s ease-out/);
  assert.ok(
    rules.includes("#curveConflict .curve-conflict-actions .action-button:first-child:hover:not(:disabled)"),
    "conflict primary action still overrides the shared hover colors"
  );
});

test("自定义曲线预设可保存，删除状态写入本地存储", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  for (const id of [
    "curvePresetSaveDialog", "curvePresetName", "curvePresetSaveConfirm",
    "curvePresetDeleteDialog", "curvePresetDeleteText", "curvePresetDeleteConfirm"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "缺少 " + id);
  }
  for (const fn of [
    "loadCustomPresets", "saveCustomPresets", "allPresets", "saveCurrentPreset",
    "openDeletePreset", "deletePreset", "startPresetHold", "cancelPresetHold"
  ]) {
    assert.ok(code.includes("function " + fn + "("), "缺少 " + fn);
  }
  assert.match(code, /dreamengine\.curve\.customPresets\.v1/);
  assert.match(code, /dreamengine\.curve\.deletedPresets\.v1/);
  assert.match(code, /setTimeout\([\s\S]*?650/);
  assert.match(code, /localStorage\.setItem/);
});

test("并发冲突只剩两个选项：覆盖 / 放弃", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  assert.ok(code.includes("curveConflictOverwrite"));
  assert.ok(code.includes("curveConflictDrop"));
  assert.ok(!code.includes("curveConflictReload"), "「重新载入」已随读取入口一起取消");
  // 覆盖时必须去掉 expect 行并加 force，否则会再次冲突
  assert.ok(code.includes('"force') && code.includes("overwrite"), "覆盖没有加 force");
  assert.ok(code.includes('indexOf("expect') && code.includes("!== 0"),
    "覆盖时没有过滤掉 expect 行");
});

test("Esc 取消拖拽：曲线回到按下把手时的样子", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const keydown = code.slice(code.indexOf("function onKeyDown("), code.indexOf("function buildText("));
  assert.ok(keydown.includes("st.drag.curve"), "没有记下拖拽前的曲线");
  assert.ok(keydown.includes("已取消这次拖拽"), "缺少取消反馈");
  assert.ok(!keydown.includes("send("), "Esc 不应该写回 AE");
});

test("四视图切换：表驱动 + 曲线视图进入不读 AE", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/library.js"));
  assert.ok(code.includes('var VIEW_TABS = { effects: "tabEffects", presets: "tabPresets", curve: "tabCurve", materials: "tabMaterials" }'));
  assert.ok(code.includes('var VIEW_PANELS = { effects: "viewEffects", presets: "viewPresets", curve: "viewCurve", materials: "viewMaterials" }'));
  assert.ok(code.includes("AEV_CurveUI.enter()"));
  assert.ok(code.includes('byId("tabCurve").addEventListener'));
});

test("index.html：曲线视图与冲突按钮齐全，且与其它顶层视图同级", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  assert.ok(html.includes('id="tabCurve"'));
  assert.ok(/id="viewCurve"[^>]*hidden/.test(html));
  assert.ok(html.includes('id="curveCanvas"'));
  const curveAt = html.indexOf('id="viewCurve"');
  assert.ok(curveAt > 0);
  assert.ok(html.indexOf('id="viewPresets"') < curveAt);
  for (const id of [
    "curveConflictOverwrite", "curveConflictDrop",
    "curvePresetSaveDialog", "curvePresetDeleteDialog"
  ]) {
    assert.ok(html.includes('id="' + id + '"'), "缺少 " + id);
  }
  assert.ok(html.indexOf('src="engine/curve_math.js"') < html.indexOf('src="js/curve.js"'));

  // 四个视图必须在**同一个**顶部切换栏里（效果 / 预设 / 曲线 / 素材），
  // 不能把曲线做成抽屉或二级入口 —— 合并分支时最容易被拆散的一条。
  const navStart = html.indexOf('<nav class="view-switch"');
  const navEnd = html.indexOf("</nav>", navStart);
  assert.ok(navStart > 0 && navEnd > navStart, "缺少顶部切换栏");
  const nav = html.slice(navStart, navEnd);
  for (const id of ["tabEffects", "tabPresets", "tabCurve", "tabMaterials"]) {
    assert.ok(nav.includes('id="' + id + '"'), id + " 不在切换栏里");
  }
  assert.equal((html.match(/class="view-switch"/g) || []).length, 1, "切换栏只能有一个");
  assert.ok(nav.indexOf("tabEffects") < nav.indexOf("tabPresets"), "顺序应为 效果 → 预设");
  assert.ok(nav.indexOf("tabPresets") < nav.indexOf("tabCurve"), "顺序应为 预设 → 曲线");
  assert.ok(nav.indexOf("tabCurve") < nav.indexOf("tabMaterials"), "顺序应为 曲线 → 素材");
});

test("CSS：视图与对话框的 [hidden] 都要显式覆盖", () => {
  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.match(css, /\.curve-view\[hidden\]\s*\{\s*display: none/);
  assert.match(css, /\.curve-conflict\[hidden\]\s*\{\s*display: none/);
  assert.match(css, /\.curve-hint\s*\{[^}]*overflow: hidden/);
});

test("bridge 先加载 curve_math 再加载 curvelib，并纳入自愈检查", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/bridge.js"));
  const mathAt = code.indexOf("engine/curve_math.js");
  const curveAt = code.indexOf("engine/curvelib.jsx");
  assert.ok(mathAt > 0 && curveAt > mathAt, "curve_math 必须排在 curvelib 之前");
  assert.match(code, /typeof AEV_Curve === 'undefined'/);
});

test("es3check 覆盖 curve_math.js（后缀是 .js 但跑在 ExtendScript 里）", () => {
  const tool = read("tools/es3check.mjs");
  assert.match(tool, /curve_math\.js/);
});

/* ============================================================
 * 三、多点曲线图（XLFlow 特征）
 * ============================================================ */

test("第三方归属记录 XLFlow 来源、提交、模块与 MIT 声明", () => {
  const notice = read("THIRD_PARTY_NOTICES.md");
  // 计划原稿写的是 /xlinnnnnnn\/XLFlow/，少了 "iao"，任何真实网址都匹配不上；
  // 按 spec 里的实际仓库名 xiaolinnnnnnn/XLFlow 断言。
  assert.match(notice, /xiaolinnnnnnn\/XLFlow/i);
  assert.match(notice, /c9e4a00b0e5279560df771fcc8807cac41199e66/);
  assert.match(notice, /MIT/);
  assert.match(notice, /js\/curve_editor\.js/);
  assert.match(notice, /jsx\/core\.jsx/);
  assert.match(notice, /no actual `LICENSE` file/i);
});

test("两节点图与旧 cubic-bezier 四元组无损往返", () => {
  const G = loadGraph();
  const input = [0.2, 0.1, 0.8, 0.9];
  const graph = G.fromBezier(input, "numeric");
  assert.equal(graph.version, 2);
  assert.equal(graph.kind, "dreamengine-curve-graph");
  assert.equal(graph.nodes.length, 2);
  assert.deepEqual(Array.from(G.toBezier(graph)), input);
});

test("节点插入排序、越界防护和删除", () => {
  const G = loadGraph();
  let graph = G.fromBezier([0.25, 0, 0.75, 1], "numeric");
  graph = G.insertNode(graph, 0.7, 0.8, "node_b");
  graph = G.insertNode(graph, 0.3, 0.2, "node_a");
  assert.deepEqual(Array.from(graph.nodes, (n) => n.id),
    ["start", "node_a", "node_b", "end"]);
  graph = G.moveNode(graph, "node_b", 0.1, 1.5);
  const b = graph.nodes.find((n) => n.id === "node_b");
  assert.ok(b.t > graph.nodes[1].t && b.t < 1);
  assert.ok(b.v >= 0 && b.v <= 1);
  graph = G.deleteNode(graph, "node_a");
  assert.ok(!graph.nodes.some((n) => n.id === "node_a"));
});

test("图和两节点曲线在时间中点采样一致", () => {
  const G = loadGraph();
  const curve = [0.25, 0.1, 0.75, 0.9];
  const graph = G.fromBezier(curve, "numeric");
  const expected = C.sampleValue(
    C.segmentOf([key(0, [0]), key(1, [1])], 0), 0, 0.5);
  const actual = G.sample(graph, 0.5)[0];
  assert.ok(Math.abs(actual - expected) < 1e-4, `${actual} vs ${expected}`);
});

test("磁吸按 0.1 网格，且只改被拖拽点", () => {
  const G = loadGraph();
  assert.equal(G.GRID, 0.1, "磁吸步长必须和 10×10 网格一致");
  assert.deepEqual(
    JSON.parse(JSON.stringify(G.snapPoint(0.374, 0.622, true))),
    { t: 0.4, v: 0.6 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(G.snapPoint(0.374, 0.622, false))),
    { t: 0.374, v: 0.622 }
  );
});

test("曲线反向保持端点并交换相邻把手", () => {
  const G = loadGraph();
  let graph = G.insertNode(
    G.fromBezier([0.2, 0, 0.8, 1], "numeric"), 0.4, 0.7, "node_1");
  graph.nodes[1].outHandle = { dt: 0.1, dv: 0.2 };
  graph.nodes[1].inHandle = { dt: -0.05, dv: -0.1 };
  const reversed = G.reverse(graph);
  assert.equal(reversed.nodes[0].t, 0);
  assert.equal(reversed.nodes[0].v, 0);
  assert.equal(reversed.nodes.at(-1).t, 1);
  assert.equal(reversed.nodes.at(-1).v, 1);
  assert.equal(reversed.nodes[1].t, 0.4);
  assert.equal(reversed.nodes[1].outHandle.dt, 0.2);
  assert.equal(reversed.nodes[1].inHandle.dt, -0.2);
});

test("曲线反向是水平镜像，不翻转节点数值", () => {
  const G = loadGraph();
  const two = G.fromBezier([0.2, 0.5, 0.8, 0.9], "numeric");
  assert.deepEqual(Array.from(G.toBezier(G.reverse(two))), [0.2, 0.9, 0.8, 0.5]);

  let multi = G.fromBezier([0.2, 0, 0.8, 1], "numeric");
  multi = G.insertNode(multi, 0.3, 0.8, "node_1");
  multi.nodes[1].outHandle = { dt: 0.1, dv: 0.2 };
  multi.nodes[1].inHandle = { dt: -0.05, dv: -0.1 };
  const reversed = G.reverse(multi);
  const middle = reversed.nodes[1];
  assert.equal(middle.t, 0.3);
  assert.equal(middle.v, 0.8);
  assert.deepEqual(
    JSON.parse(JSON.stringify(middle.inHandle)),
    { dt: -0.2, dv: -0.8 }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(middle.outHandle)),
    { dt: 0.2, dv: 0.2 }
  );
});

test("canvas 命中优先把手，其次节点", () => {
  const G = loadGraph();
  const graph = G.fromBezier([0.33, 0, 0.67, 1], "numeric");
  const map = {
    X: (v) => v * 100,
    Y: (v) => 100 - v * 100
  };
  assert.equal(G.hitTest(graph, { x: 33, y: 100 }, map, 8).kind, "handle");
  assert.equal(G.hitTest(graph, { x: 100, y: 0 }, map, 8).kind, "node");
});

/* ---------- 工具栏与本地历史 ---------- */

function loadToolbar() {
  const context = vm.createContext({});
  vm.runInContext(read(`${ENGINE}/curve_math.js`), context);
  vm.runInContext(read(`${ENGINE}/curve_graph.js`), context);
  vm.runInContext(read("cep/com.dreamengine.panel/js/curve_toolbar.js"), context, {
    filename: "curve_toolbar.js",
  });
  return context.AEV_CurveToolbar;
}

test("本地历史最多保留 20 条并可撤销重做", () => {
  const T = loadToolbar();
  const history = T.createHistory(20);
  for (let i = 0; i < 25; i++) T.pushHistory(history, { step: i });
  assert.equal(history.items.length, 20);
  assert.equal(T.undoHistory(history).step, 23);
  assert.equal(T.undoHistory(history).step, 22);
  assert.equal(T.redoHistory(history).step, 23);
});

test("曲线工具栏控件和两种编辑模式齐全", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  for (const id of [
    "curveToolbar", "curveModeTwo", "curveModeMulti", "curveRead",
    "curveReverse", "curveSwap", "curveFreezeLeft", "curveFreezeRight",
    "curveSnap", "curveUndo", "curveRedo", "curveReset"
  ]) assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  const css = read("cep/com.dreamengine.panel/css/style.css");
  for (const selector of [
    ".curve-toolbar", ".curve-toolbar-group", ".curve-tool-button",
    ".curve-tool-button.active"
  ]) assert.ok(css.includes(selector), `missing ${selector}`);
});

/* ---------- 多点画布交互 ---------- */

test("多点模式双击插点、拖节点/把手、Delete 删除", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  for (const token of [
    "function onDoubleClick",
    "AEV_CurveGraph.insertNode",
    "AEV_CurveGraph.moveNode",
    "AEV_CurveGraph.moveHandle",
    "AEV_CurveGraph.deleteNode",
    "st.selectedNodeId",
    "st.snapEnabled"
  ]) assert.ok(code.includes(token), `missing ${token}`);
  assert.match(code, /key === "Delete"[^\n]*keyCode === 46|keyCode === 46[^\n]*key === "Delete"/);
});

test("两点模式继续走原来的 st.curve 拖拽路径", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const drag = code.slice(code.indexOf("function applyDrag("),
    code.indexOf("function onMouseUp("));
  assert.ok(drag.includes("if (st.graphMode ==="));
  assert.ok(drag.includes("st.curve.x1 = nx"));
});

/* ---------- AE 侧：选区解析与图回读 ---------- */

test("无选择元数据时，两总键属性回退为首尾两键", () => {
  const context = vm.createContext({});
  vm.runInContext(read(`${ENGINE}/curve_math.js`), context);
  vm.runInContext(read(`${ENGINE}/curve_graph.js`), context);
  vm.runInContext(read(`${ENGINE}/curvelib.jsx`), context);
  const prop = {
    name: "Opacity", matchName: "ADBE Opacity", propertyDepth: 1,
    numKeys: 2, value: 100, isSpatial: false, dimensionsSeparated: false,
    selectedKeys: null, comment: "",
    keyTime: (k) => (k === 1 ? 0 : 1),
    keyValue: (k) => (k === 1 ? 0 : 100),
    keyInInterpolationType: () => 6612,
    keyOutInterpolationType: () => 6612,
    keyInTemporalEase: () => [{}], keyOutTemporalEase: () => [{}],
    keyInSpatialTangent: () => [0], keyOutSpatialTangent: () => [0],
    propertyGroup: () => null
  };
  const comp = {
    name: "Comp", numLayers: 1, time: 0,
    selectedProperties: [prop], selectedLayers: []
  };
  context.app = {
    version: "23.0",
    project: { activeItem: comp, items: [comp] }
  };
  const data = JSON.parse(context.AEV_Curve.readGraphJson());
  assert.equal(data.status, "ok");
  assert.equal(data.props[0].graph.nodes.length, 2);
});

test("元数据损坏时忽略图但保留普通评论", () => {
  const { C } = loadEngine();
  const parsed = C.parseGraphMeta(
    "keep me\n[[DREAMENGINE_CURVE_META_V1]]broken[[/DREAMENGINE_CURVE_META_V1]]\nend");
  assert.equal(parsed.ok, false);
  assert.match(parsed.plain, /keep me/);
  assert.match(parsed.plain, /end/);
});

/* ---------- AE 侧：安全写回 ---------- */

function mockGraphProp(times, values, options) {
  const opts = options || {};
  const dims = opts.dims || 1;
  const vectors = values.map((value) => Array.isArray(value) ? value.slice() : [value]);
  let keys = times.map((t, i) => ({
    t, v: vectors[i].slice(), tin: 2, tout: 2,
    is: new Array(dims).fill(0), ii: new Array(dims).fill(33.33),
    os: new Array(dims).fill(0), oi: new Array(dims).fill(33.33),
    it: new Array(dims).fill(0), ot: new Array(dims).fill(0)
  }));
  const easeWrites = [];
  /* 托管元数据存在图层注释里，所以假属性必须能向上找到「图层」：
     layerOfProp 用 typeof index === "number" 认图层，属性组没有这个字段。 */
  const layer = { index: 1, comment: "", containingComp: { name: "Comp" } };
  return {
    name: "Slider", matchName: "ADBE Slider Control", propertyDepth: 0,
    value: vectors[0].slice(), isSpatial: !!opts.spatial, dimensionsSeparated: false,
    selectedKeys: [1, keys.length], comment: "",
    _layer: layer,
    get numKeys() { return keys.length; },
    keyTime: (k) => keys[k - 1].t,
    keyValue: (k) => keys[k - 1].v,
    keyInInterpolationType: (k) => keys[k - 1].tin,
    keyOutInterpolationType: (k) => keys[k - 1].tout,
    keyInTemporalEase: (k) => keys[k - 1].is.map((speed, i) => ({
      speed, influence: keys[k - 1].ii[i]
    })),
    keyOutTemporalEase: (k) => keys[k - 1].os.map((speed, i) => ({
      speed, influence: keys[k - 1].oi[i]
    })),
    keyInSpatialTangent: (k) => keys[k - 1].it.slice(),
    keyOutSpatialTangent: (k) => keys[k - 1].ot.slice(),
    keyRoving: () => false, keyTemporalAutoBezier: () => false,
    setTemporalAutoBezierAtKey: () => {},
    setInterpolationTypeAtKey: (k, tin, tout) => {
      keys[k - 1].tin = tin === 6612 ? 1 : tin === 6614 ? 3 : 2;
      keys[k - 1].tout = tout === 6612 ? 1 : tout === 6614 ? 3 : 2;
    },
    setTemporalEaseAtKey: (k, inEase, outEase) => {
      easeWrites.push(k);
      keys[k - 1].is = inEase.map((e) => e.speed);
      keys[k - 1].ii = inEase.map((e) => e.influence);
      keys[k - 1].os = outEase.map((e) => e.speed);
      keys[k - 1].oi = outEase.map((e) => e.influence);
    },
    setValueAtTime: (t, value) => {
      const at = keys.findIndex((k) => Math.abs(k.t - t) < 0.0001);
      const next = { t, v: Array.isArray(value) ? value.slice() : [value],
        tin: 2, tout: 2,
        is: new Array(dims).fill(0), ii: new Array(dims).fill(33.33),
        os: new Array(dims).fill(0), oi: new Array(dims).fill(33.33),
        it: new Array(dims).fill(0), ot: new Array(dims).fill(0) };
      if (at >= 0) keys[at] = next;
      else keys.push(next);
      keys.sort((a, b) => a.t - b.t);
    },
    setSpatialTangentsAtKey: (k, inTans, outTans) => {
      keys[k - 1].it = inTans.slice(0, dims);
      keys[k - 1].ot = outTans.slice(0, dims);
    },
    setSpatialAutoBezierAtKey: () => {},
    removeKey: (k) => { keys.splice(k - 1, 1); },
    propertyGroup: (i) => (i === 1 ? layer : null),
    _easeWrites: () => easeWrites,
    _keys: () => keys
  };
}

function graphContext() {
  const context = vm.createContext({
    KeyframeEase: function (speed, influence) {
      this.speed = speed; this.influence = influence;
    },
    KeyframeInterpolationType: { LINEAR: 6612, BEZIER: 6613, HOLD: 6614 }
  });
  vm.runInContext(read(`${ENGINE}/curve_math.js`), context);
  vm.runInContext(read(`${ENGINE}/curve_graph.js`), context);
  vm.runInContext(read(`${ENGINE}/curvelib.jsx`), context);
  return context;
}

test("区间存在用户原生中间键时整条属性不改", () => {
  const context = graphContext();
  const prop = mockGraphProp([0, 0.5, 1], [0, 40, 100]);
  prop.selectedKeys = [1, 3];
  const comp = {
    name: "Comp", numLayers: 1, time: 0,
    selectedProperties: [prop], selectedLayers: []
  };
  context.app = { beginUndoGroup() {}, endUndoGroup() {},
    project: { activeItem: comp, items: [comp] } };
  const graph = context.AEV_CurveGraph.fromBezier([0.2, 0, 0.8, 1], "numeric");
  graph.nodes.splice(1, 0, {
    id: "node_1", role: "middle", t: 0.5, v: 0.5,
    inHandle: { dt: -0.1, dv: 0 }, outHandle: { dt: 0.1, dv: 0 }
  });
  const text = "force\n" + context.AEV_CurveGraph.encodeApplyLines(
    "Comp|Slider", "", graph);
  const result = JSON.parse(context.AEV_Curve.applyText(text));
  assert.deepEqual(Array.from(result.skipped), ["native_intermediate"]);
  assert.deepEqual(prop._keys().map((k) => k.t), [0, 0.5, 1]);
  assert.deepEqual(prop._keys().map((k) => k.v[0]), [0, 40, 100]);
});

test("选中非首段关键帧时，ease 只写入选区及其新中间键", () => {
  const context = graphContext();
  const prop = mockGraphProp([0, 1, 2], [0, 10, 100]);
  prop.selectedKeys = [2, 3];
  prop._keys()[0].is = [11];
  prop._keys()[0].ii = [44];
  prop._keys()[0].os = [22];
  prop._keys()[0].oi = [55];
  const comp = {
    name: "Comp", numLayers: 1, time: 0,
    selectedProperties: [prop], selectedLayers: []
  };
  context.app = { beginUndoGroup() {}, endUndoGroup() {},
    project: { activeItem: comp, items: [comp] } };

  const graph = context.AEV_CurveGraph.fromBezier([0.2, 0, 0.8, 1], "numeric");
  graph.nodes.splice(1, 0, {
    id: "node_1", role: "middle", t: 0.5, v: 0.5,
    inHandle: { dt: -0.1, dv: 0 }, outHandle: { dt: 0.1, dv: 0 }
  });
  const result = JSON.parse(context.AEV_Curve.applyText(
    "force\n" + context.AEV_CurveGraph.encodeApplyLines("Comp|Slider", "", graph)));

  assert.equal(result.status, "ok");
  assert.deepEqual(prop._keys().map((k) => k.t), [0, 1, 1.5, 2]);
  assert.deepEqual(prop._easeWrites(), [2, 3, 3, 4]);
  assert.deepEqual(prop._keys()[0], {
    t: 0, v: [0], tin: 2, tout: 2,
    is: [11], ii: [44], os: [22], oi: [55], it: [0], ot: [0]
  });
});

test("ease 写入失败时不报告成功，但保留可清理的托管元数据", () => {
  const context = graphContext();
  const prop = mockGraphProp([0, 1], [0, 100]);
  prop.setTemporalEaseAtKey = () => {
    throw new Error("AE rejected ease");
  };
  const comp = {
    name: "Comp", numLayers: 1, time: 0,
    selectedProperties: [prop], selectedLayers: []
  };
  context.app = { beginUndoGroup() {}, endUndoGroup() {},
    project: { activeItem: comp, items: [comp] } };

  const graph = context.AEV_CurveGraph.fromBezier([0.2, 0, 0.8, 1], "numeric");
  graph.nodes.splice(1, 0, {
    id: "node_1", role: "middle", t: 0.5, v: 0.5,
    inHandle: { dt: -0.1, dv: 0 }, outHandle: { dt: 0.1, dv: 0 }
  });
  const result = JSON.parse(context.AEV_Curve.applyText(
    "force\n" + context.AEV_CurveGraph.encodeApplyLines("Comp|Slider", "", graph)));

  assert.equal(result.applied, 0);
  assert.deepEqual(Array.from(result.skipped), ["ease_write_failed"]);
  assert.equal(prop.numKeys, 3);
  assert.match(prop._layer.comment, /DREAMENGINE_CURVE_META_V1/);
  const meta = context.AEV_Curve.parseGraphMeta(prop._layer.comment);
  assert.equal(meta.ok, true);
  assert.equal(meta.entries[0].complete, false);
});

test("关键帧交换会随值和缓动一起交换空间切线", () => {
  const context = graphContext();
  const prop = mockGraphProp([0, 1], [[10, 20], [90, 80]], {
    dims: 2, spatial: true
  });
  prop.selectedKeys = [1, 2];
  prop._keys()[0].it = [1, 2];
  prop._keys()[0].ot = [3, 4];
  prop._keys()[1].it = [5, 6];
  prop._keys()[1].ot = [7, 8];
  const comp = {
    name: "Comp", numLayers: 1, time: 0,
    selectedProperties: [prop], selectedLayers: []
  };
  context.app = { beginUndoGroup() {}, endUndoGroup() {},
    project: { activeItem: comp, items: [comp] } };

  const result = JSON.parse(context.AEV_Curve.applyText(
    "force\nexpect\tComp|Slider\t\ntool\tComp|Slider\tswap"));
  assert.equal(result.applied, 1);
  assert.deepEqual(prop._keys()[0].v, [90, 80]);
  assert.deepEqual(prop._keys()[1].v, [10, 20]);
  assert.deepEqual(Array.from(prop._keys()[0].it), [5, 6]);
  assert.deepEqual(Array.from(prop._keys()[0].ot), [7, 8]);
  assert.deepEqual(Array.from(prop._keys()[1].it), [1, 2]);
  assert.deepEqual(Array.from(prop._keys()[1].ot), [3, 4]);
});

test("左右冻结会清零所有选中空间关键帧的切线", () => {
  const context = graphContext();
  const prop = mockGraphProp([0, 1, 2], [[10, 20], [50, 60], [90, 80]], {
    dims: 2, spatial: true
  });
  prop.selectedKeys = [1, 2, 3];
  for (let i = 0; i < 3; i++) {
    prop._keys()[i].it = [i + 1, i + 2];
    prop._keys()[i].ot = [i + 3, i + 4];
  }
  const comp = {
    name: "Comp", numLayers: 1, time: 0,
    selectedProperties: [prop], selectedLayers: []
  };
  context.app = { beginUndoGroup() {}, endUndoGroup() {},
    project: { activeItem: comp, items: [comp] } };

  const result = JSON.parse(context.AEV_Curve.applyText(
    "force\nexpect\tComp|Slider\t\ntool\tComp|Slider\tfreeze_left"));
  assert.equal(result.applied, 1);
  assert.deepEqual(prop._keys().map((k) => k.v), [[10, 20], [10, 20], [10, 20]]);
  for (const key of prop._keys()) {
    assert.deepEqual(Array.from(key.it), [0, 0]);
    assert.deepEqual(Array.from(key.ot), [0, 0]);
  }
});

test("重复应用只删除本产品管理的旧中间键", () => {
  const context = graphContext();
  const prop = mockGraphProp([0, 1], [0, 100]);
  const comp = {
    name: "Comp", numLayers: 1, time: 0,
    selectedProperties: [prop], selectedLayers: []
  };
  context.app = { beginUndoGroup() {}, endUndoGroup() {},
    project: { activeItem: comp, items: [comp] } };
  const first = context.AEV_CurveGraph.fromBezier([0.2, 0, 0.8, 1], "numeric");
  first.nodes.splice(1, 0, {
    id: "node_1", role: "middle", t: 0.5, v: 0.5,
    inHandle: { dt: -0.1, dv: 0 }, outHandle: { dt: 0.1, dv: 0 }
  });
  context.AEV_Curve.applyText(
    "force\n" + context.AEV_CurveGraph.encodeApplyLines("Comp|Slider", "", first));
  assert.equal(prop.numKeys, 3);
  assert.match(prop._layer.comment, /DREAMENGINE_CURVE_META_V1/);

  const second = context.AEV_CurveGraph.fromBezier([0.3, 0, 0.7, 1], "numeric");
  second.nodes.splice(1, 0, {
    id: "node_1", role: "middle", t: 0.4, v: 0.3,
    inHandle: { dt: -0.1, dv: 0 }, outHandle: { dt: 0.1, dv: 0 }
  });
  const result = JSON.parse(context.AEV_Curve.applyGraphForPropertyJson(
    "Comp|Slider", 1, prop.numKeys,
    context.AEV_CurveGraph.encodeGraphPayload(second), ""));
  assert.equal(result.status, "ok");
  assert.equal(prop.numKeys, 3);
  assert.ok(Math.abs(prop._keys()[1].t - 0.4) < 0.0001);
});

/* ---------- 面板集成 ---------- */

test("多点应用发送 expect + graph_begin/node/end，不退回单曲线 buildText", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  for (const token of [
    "function buildGraphText",
    "encodeApplyLines",
    "AEV_Curve.applyText",
    "st.graphMode",
    "st.pendingText"
  ]) assert.ok(code.includes(token), `missing ${token}`);
  const graphBody = code.slice(code.indexOf("function buildGraphText("),
    code.indexOf("function apply("));
  assert.ok(graphBody.includes("expect"));
  assert.ok(graphBody.includes("graph"));
});

test("bridge 先加载 curve_math 和 curve_graph，再加载 curvelib", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/bridge.js"));
  const mathAt = code.indexOf("engine/curve_math.js");
  const graphAt = code.indexOf("engine/curve_graph.js");
  const curveAt = code.indexOf("engine/curvelib.jsx");
  assert.ok(mathAt > 0 && graphAt > mathAt && curveAt > graphAt);
  assert.match(code, /typeof AEV_CurveGraph === 'undefined'/);
});

test("es3check 覆盖 curve_graph.js", () => {
  assert.match(read("tools/es3check.mjs"), /curve_graph\.js/);
});

test("es3check 捕获对象字面量里的 ES3 保留字键", () => {
  const dir = mkdtempSync(join(tmpdir(), "dreamengine-es3-"));
  const file = join(dir, "reserved.jsx");
  try {
    writeFileSync(file, "var value = { in: 1 };\n", "utf8");
    const run = spawnSync(
      process.execPath,
      [join(ROOT, "tools", "es3check.mjs"), file],
      { encoding: "utf8" }
    );
    assert.equal(run.status, 1,
      "es3check 应把对象字面量里的保留字键视为语法错误\n" + run.stdout);
    assert.match(run.stdout, /reserved-object-key/);
  } finally {
    rmSync(file, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("curvelib 不使用 ES3 保留字 in 作为对象键", () => {
  const code = codeOf(read(`${ENGINE}/curvelib.jsx`));
  assert.doesNotMatch(code, /\{\s*in\s*:/,
    "ES3 会把对象字面量里的 in 属性名当成保留字并拒绝执行");
});

test("四节点图：两个中间键都按端点插值，第二个不会串到前一个键上", () => {
  const context = graphContext();
  const prop = mockGraphProp([0, 2], [0, 100]);
  const comp = {
    name: "Comp", numLayers: 1, time: 0,
    selectedProperties: [prop], selectedLayers: []
  };
  context.app = { beginUndoGroup() {}, endUndoGroup() {},
    project: { activeItem: comp, items: [comp] } };
  const G = context.AEV_CurveGraph;
  let g = G.fromBezier([0, 0, 1, 1], "numeric");
  g = G.insertNode(g, 0.3, 0.1);
  g = G.insertNode(g, 0.6, 0.9);
  const res = JSON.parse(context.AEV_Curve.applyGraphForPropertyJson(
    "Comp|Slider", 1, prop.numKeys, G.encodeGraphPayload(g), ""));
  assert.equal(res.status, "ok");
  /* 曾经第二个中间节点按 eIdx 取值，而插入第一个键后索引已位移，
     0.9 被算成 9 —— 曲线形状对、运动完全不对，三项以内的图还测不出来。 */
  assert.deepEqual(prop._keys().map((k) => k.v[0]), [0, 10, 90, 100]);
});

test("把手 dt=0 时不给 AE 一条水平把手", () => {
  const G = loadGraph();
  let g = G.fromBezier([0, 0, 1, 1], "numeric");
  g = G.insertNode(g, 0.5, 0.5);
  /* dt=0 + dv≠0 是「竖直把手」：画出来是一条陡升，写回 AE 若把斜率算成 0
     就变成水平 —— 形状与运动对不上。 */
  g = G.moveHandle(g, g.nodes[0].id, "out", 0, 0.15);
  const curve = G.segmentCurve(g, 0);
  assert.ok(curve[0] >= 0.001, "x1 退化成 0，斜率会算成 0");
  assert.ok(G.segmentEase(g, 0).mOut > 1, "竖直把手应该换算成大斜率，而不是 0");
});

test("交叉把手被拉开，x 保持单调", () => {
  const G = loadGraph();
  let g = G.fromBezier([0, 0, 1, 1], "numeric");
  g = G.insertNode(g, 0.5, 0.5);
  /* out 把手伸到段尾、in 把手伸到段首：x1 >= x2，时间轴上等于回折 */
  g = G.moveHandle(g, g.nodes[0].id, "out", 0.5, 0.1);
  g = G.moveHandle(g, g.nodes[1].id, "in", -0.5, -0.1);
  const c = G.segmentCurve(g, 0);
  assert.ok(c[2] > c[0], `x1=${c[0]} 必须小于 x2=${c[2]}，否则 AE 表示不出来`);
});

test("读取自动切多点后，工具栏按钮跟着变", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  assert.ok(code.includes("function syncToolbarMode("), "缺少 syncToolbarMode");
  const sw = code.slice(
    code.indexOf("function switchGraphMode("),
    code.indexOf("function setGraphState(")
  );
  assert.ok(sw.includes("syncToolbarMode("), "切模式后没有回告工具栏");
  /* 工具栏自己的 setMode 会回调 switchGraphMode，必须靠 snapshot 比较来断环 */
  const sync = code.slice(
    code.indexOf("function syncToolbarMode("),
    code.indexOf("function switchGraphMode(")
  );
  assert.ok(sync.includes("snapshot("), "缺少模式比较，会造成工具栏与画布互相覆盖");
});

test("曲线页是「编辑器 + 分隔条 + 预设」三栏，工具栏用图标并可翻页", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  for (const id of [
    "curveSplit", "curveEditorPane", "curveResizer", "curvePresetsPane",
    "curveToolbarViewport", "curveToolbarTrack", "curveToolbarPrev", "curveToolbarNext"
  ]) assert.ok(html.includes(`id="${id}"`), "缺少 " + id);

  const css = read("cep/com.dreamengine.panel/css/style.css");
  for (const sel of [
    ".curve-split", ".curve-resizer", ".curve-toolbar-track",
    ".curve-toolbar-arrow", ".curve-toolbar-viewport", ".curve-action-btn"
  ]) assert.ok(css.includes(sel), "缺少样式 " + sel);
  assert.ok(
    /@media\s*\(min-width:\s*640px\)\s*and\s*\(min-aspect-ratio:\s*6\/5\)/.test(css),
    "曲线页应在宽度足够且横向比例合理时才分栏"
  );

  /* 工具栏必须是图标按钮：每个按钮里都有 <img>，且图片文件真的存在 */
  /* 只取 track 本体：右箭头在 viewport 之外，算进来会多一个 */
  const track = html.slice(
    html.indexOf('id="curveToolbarTrack"'),
    html.indexOf('id="curveToolbarNext"')
  );
  const buttons = (track.match(/class="curve-tool-button/g) || []).length;
  const imgs = [...track.matchAll(/src="(svg\/[^"]+)"/g)].map((m) => m[1]);
  assert.equal(buttons, 11, "工具栏按钮数变了，同步改这里");
  assert.equal(imgs.length, buttons, "有按钮没配图标");
  for (const src of imgs) {
    assert.ok(existsSync(join(ROOT, "cep", "com.dreamengine.panel", src)), "图标文件缺失：" + src);
  }
  /* 图标按钮不能再有可见文字（i18n 只能挂在 title / aria 上） */
  assert.equal(
    (track.match(/data-i18n="/g) || []).length, 0,
    "工具栏按钮还挂着 data-i18n，会把 <img> 冲掉"
  );
});

test("曲线画布可切换填充与正方形视图，并记住选择", () => {
  const html = read("cep/com.dreamengine.panel/index.html");
  assert.ok(html.includes('id="curveViewToggle"'), "缺少视图切换按钮");
  assert.ok(html.includes("curve-view-icon-fill"), "缺少填充视图图标");
  assert.ok(html.includes("curve-view-icon-square"), "缺少正方形视图图标");
  assert.ok(html.includes('aria-pressed="false"'), "视图切换按钮缺少初始按下状态");

  const css = read("cep/com.dreamengine.panel/css/style.css");
  assert.ok(css.includes(".curve-view-toggle"), "缺少视图切换按钮样式");
  assert.ok(css.includes('.curve-view-toggle[aria-pressed="true"]'), "缺少正方形选中样式");

  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  assert.ok(code.includes("dreamengine.curve.view.v1"), "视图选择没有持久化键");
  assert.ok(code.includes("function toggleViewMode("), "缺少视图切换逻辑");
  assert.ok(code.includes("storageSet(VIEW_KEY"), "切换后没有保存视图选择");
  assert.ok(code.includes('st.view === "square"'), "绘图区没有正方形分支");
  assert.ok(code.includes("mapRect: st.map"), "快照没有暴露实际绘图区，无法验证比例");
});

test("窄面板分隔条按高度计算比例，宽屏才按宽度", () => {
  const loadSplit = (direction) => {
    const context = vm.createContext({
      window: {
        localStorage: { getItem: () => "", setItem: () => {} },
        getComputedStyle: () => ({ flexDirection: direction }),
        addEventListener: () => {}
      },
      document: { addEventListener: () => {}, body: { style: {} } }
    });
    vm.runInContext(read("cep/com.dreamengine.panel/js/curve_split.js"), context, {
      filename: "curve_split.js"
    });
    return context.AEV_CurveSplit;
  };
  const makeTree = () => {
    const split = { clientWidth: 300, clientHeight: 493 };
    const editor = {
      offsetWidth: 120, offsetHeight: 330, style: {},
      setAttribute: () => {}
    };
    const presets = { offsetWidth: 170, offsetHeight: 150, style: {} };
    const resizer = {
      addEventListener: () => {}, setAttribute: () => {},
      classList: { add: () => {}, remove: () => {} }
    };
    return { split, editor, presets, resizer };
  };

  const narrow = loadSplit("column");
  const narrowTree = makeTree();
  assert.equal(narrow.init(narrowTree), true);
  assert.ok(Math.abs(narrow.ratio() - 330 / 486) < 1e-6);

  const wide = loadSplit("row");
  const wideTree = makeTree();
  assert.equal(wide.init(wideTree), true);
  assert.ok(Math.abs(wide.ratio() - 120 / 293) < 1e-6);
});

test("内置多点预设：每张图都能被图模型接受", () => {
  const src = read("cep/com.dreamengine.panel/js/curve.js");
  const start = src.indexOf("var GRAPH_PRESETS = [");
  assert.ok(start > 0, "找不到 GRAPH_PRESETS");
  const end = src.indexOf("];", start);
  const literal = src.slice(start, end + 2);

  const ctx = vm.createContext({});
  vm.runInContext(read(`${ENGINE}/curve_math.js`), ctx);
  vm.runInContext(read(`${ENGINE}/curve_graph.js`), ctx);
  vm.runInContext(literal + "\nthis.__presets = GRAPH_PRESETS;", ctx);

  const G = ctx.AEV_CurveGraph;
  const list = ctx.__presets;
  assert.ok(list.length >= 3, "多点预设至少给三条，否则这个功能等于没有");
  for (const p of list) {
    assert.ok(p.id && p.zh && p.en, "预设缺 id 或名称：" + p.id);
    const g = G.normalize(p.g);
    assert.ok(g, `预设 ${p.id} 的图不合法（normalize 返回 null）`);
    assert.ok(g.nodes.length >= 3, `预设 ${p.id} 只有 ${g.nodes.length} 个节点，应归到两点类`);
    assert.equal(g.nodes[0].t, 0);
    assert.equal(g.nodes[g.nodes.length - 1].t, 1);
  }
});

test("Delete 与 Backspace 都能删点，但输入框里的 Backspace 不删", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  const from = code.indexOf("function onKeyDown(");
  assert.ok(from > 0, "找不到 onKeyDown");
  /* onKeyDown 在后半段，结束位置必须从它自己往后找 */
  const fn = code.slice(from, code.indexOf("function init(", from));
  assert.ok(/Backspace/.test(fn), "没有支持 Backspace 删点");
  assert.ok(/nodeName === "INPUT"/.test(fn), "没有排除输入框，打字会把节点删掉");
  assert.ok(
    fn.indexOf('nodeName === "INPUT"') < fn.indexOf("deleteNode("),
    "输入框守卫必须排在删点之前"
  );
});

test("值图按过冲取景，拖拽期间锁住视野", () => {
  const code = codeOf(read("cep/com.dreamengine.panel/js/curve.js"));
  assert.ok(code.includes("function valueWindow("), "缺少 valueWindow");

  /* 取景必须把把手/节点的过冲算进去，否则过冲被裁到框外看不见 */
  const win = code.slice(code.indexOf("function valueWindow("), code.indexOf("function makeMap("));
  assert.ok(win.includes("inHandle") && win.includes("outHandle"), "取景没算把手");
  assert.ok(win.includes("st.curve.y1") && win.includes("st.curve.y2"), "取景没算两点曲线");
  assert.ok(win.includes("lo = 0") && win.includes("hi = 1"), "取景没把 0..1 保底包进来");

  /* 映射必须吃这个窗口 */
  assert.ok(code.includes("makeMap(rect, win.lo, win.hi)"), "画布映射没用取景窗口");

  /* 拖拽期间必须冻结，否则视野随拖动扩张会形成正反馈、把手抖起来 */
  assert.equal(
    (code.match(/win: valueWindow\(\)/g) || []).length, 2,
    "两处拖拽起点都要锁存取景"
  );
  assert.ok(
    code.includes("st.drag && st.drag.win ? st.drag.win : valueWindow()"),
    "画布没有优先使用拖拽中锁存的取景"
  );

  /* 网格与端点也得走映射，否则过冲那一段没有格子可读 */
  const grid = code.slice(code.indexOf("function drawUnitGrid("), code.indexOf("function drawCorner("));
  assert.ok(grid.includes("map.X(") && grid.includes("map.Y("), "网格没走映射");
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
    console.error(String(error && error.stack ? error.stack : error));
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exitCode = failed === 0 ? 0 : 1;
