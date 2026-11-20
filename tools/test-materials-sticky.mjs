#!/usr/bin/env node
/* ============================================================
 * test-materials-sticky.mjs —— 素材页路径栏吸顶回归
 *
 * 需求：面包屑 + 换目录 / 刷新 这一行在素材列表滚动时保持可见。
 *
 * 断言口径（只说能测的）：
 *   1. 滚动 240px 后，头部相对右栏顶部的偏移不变，且仍在可视区内
 *   2. 头部仍在右栏内边距之内，没有溢出到分类栏
 *   3. 滚动前头部与首行卡片的间距仍是 12px
 *   4. 铺底伪元素存在、不透明、向上下左右外扩（负责遮挡滚动中的卡片）
 *
 * 第 4 条是必要的：只看头部自身位置无法发现「卡片从头部两侧的
 * 内边距缝隙里透出来」这类问题，而那正是用伪元素铺底要解决的。
 * ============================================================ */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
const SIM = resolve(PANEL, "__sim_materials_sticky.html");

const browser = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((path) => existsSync(path));
if (!browser) {
  console.log("skip: Chrome/Edge not found");
  process.exit(0);
}

const cards = Array.from(
  { length: 24 },
  (_, i) => `<div class="material-card"><div class="material-preview"></div>` +
    `<div class="material-card-body">卡 ${i}</div></div>`,
).join("");

const pageScript = `
function rc(el) { return el.getBoundingClientRect(); }
var main = document.querySelector(".materials-main");
var head = document.querySelector(".materials-head");
var grid = document.getElementById("materialGrid");
var out = {};

out.headTopBefore = Math.round(rc(head).top - rc(main).top);
out.headLeftBefore = Math.round(rc(head).left - rc(main).left);
out.gridTopBefore = Math.round(rc(grid).top - rc(head).bottom);
out.stuckBefore = head.className.indexOf("is-stuck") >= 0;
out.shadowBefore = getComputedStyle(head, "::after").backgroundImage;

/* 滚动部分必须等 sticky_shadow.js 绑定完（它挂的是 DOMContentLoaded），
   否则脚本解析期 dispatch 的 scroll 事件没有监听者。 */
function finish() {
  main.scrollTop = 240;
  main.dispatchEvent(new Event("scroll"));
  out.scrolled = Math.round(main.scrollTop);
  out.headTopAfter = Math.round(rc(head).top - rc(main).top);
  out.headVisible = rc(head).bottom > rc(main).top && rc(head).top < rc(main).bottom;
  out.stuckAfter = head.className.indexOf("is-stuck") >= 0;
  out.shadowAfter = getComputedStyle(head, "::after").backgroundImage;
  out.headShadowAfter = getComputedStyle(head).boxShadow;

  var band = getComputedStyle(head, "::before");
out.band = { bg: band.backgroundColor, top: band.top, left: band.left, bottom: band.bottom };

/* 层级不变式：吸顶条必须压在「卡片悬停层」之上，否则悬停的卡会翻到头部上面；
   但必须低于设置抽屉与弹窗，避免盖住遮罩。
   直接从样式表里读出这些规则的值，而不是把数字抄进测试 —— 抄死数字的话
   以后有人调了卡片悬停 z-index，测试仍然通过，层级却已经破了。 */
out.zLayers = (function () {
  var found = { cardHover: null, drawer: null, about: null };
  var sheets = document.styleSheets;
  for (var s = 0; s < sheets.length; s++) {
    var rules;
    try { rules = sheets[s].cssRules; } catch (e) { continue; }
    if (!rules) continue;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (!rule.selectorText || !rule.style) continue;
      var sel = rule.selectorText;
      var z = rule.style.zIndex;
      if (!z) continue;
      if (sel.indexOf(".material-card:hover") >= 0 && found.cardHover === null) {
        found.cardHover = parseInt(z, 10);
      }
      if (sel.indexOf(".settings-drawer") >= 0 && found.drawer === null) {
        found.drawer = parseInt(z, 10);
      }
      if (sel.indexOf(".about-mask") >= 0 && found.about === null) {
        found.about = parseInt(z, 10);
      }
    }
  }
  found.head = parseInt(getComputedStyle(head).zIndex, 10);
  return found;
})();

document.getElementById("out").textContent = "RESULT=" + JSON.stringify(out);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", finish);
} else {
  finish();
}
`;

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<link rel="stylesheet" href="css/style.css"/></head>
<body style="margin:0;height:100vh;display:flex;flex-direction:column">
<section class="materials-view" style="flex:1;min-height:0">
  <aside class="materials-sidebar"><ul class="category-list"></ul></aside>
  <main class="materials-main">
    <div class="materials-head">
      <nav class="material-breadcrumb">
        <span class="material-crumb">AE</span>
        <span class="material-crumb-sep">›</span>
        <span class="material-crumb current">素材</span>
      </nav>
      <div class="materials-head-actions">
        <button class="icon-button">a</button><button class="icon-button">b</button>
      </div>
    </div>
    <div class="grid" id="materialGrid">${cards}</div>
  </main>
</section>
<pre id="out"></pre>
<script src="js/sticky_shadow.js"></script>
<script>${pageScript}</script></body></html>`;

writeFileSync(SIM, html, "utf8");
let dom = "";
try {
  dom = execFileSync(
    browser,
    ["--headless", "--disable-gpu", "--window-size=455,600",
     "--allow-file-access-from-files", "--dump-dom", "--virtual-time-budget=4000",
     "file:///" + SIM.replace(/\\/g, "/")],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
} finally {
  unlinkSync(SIM);
}

const pre = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
assert.ok(pre, "页面没有输出");
const text = pre[1].trim();
assert.ok(text.indexOf("RESULT=") === 0, `页面脚本异常：${text.slice(0, 160)}`);
const r = JSON.parse(text.slice(7));

assert.ok(r.scrolled > 0, "测试前提不成立：内容没有滚动");
assert.equal(r.headTopBefore, r.headTopAfter, `吸顶失效：滚动前 ${r.headTopBefore}px → 滚动后 ${r.headTopAfter}px`);
assert.equal(r.headVisible, true, "滚动后头部不在可视区内");
assert.ok(r.headLeftBefore > 0 && r.headLeftBefore < 20, `头部应位于右栏内边距之内，实得 ${r.headLeftBefore}px`);
assert.equal(r.gridTopBefore, 12, `头部与首行间距应为 12px，实得 ${r.gridTopBefore}px`);
assert.notEqual(r.band.bg, "rgba(0, 0, 0, 0)", "铺底伪元素不应透明");
assert.equal(r.band.top, "-40px", "铺底伪元素应向上外扩");
assert.equal(r.band.left, "-40px", "铺底伪元素应向左右外扩");

/* 投影：静止时不出现，滚动后出现 */
assert.equal(r.stuckBefore, false, "未滚动时不应带 is-stuck");
assert.equal(r.shadowBefore, "none", `未滚动时不应有投影，实得 ${r.shadowBefore}`);
assert.equal(r.stuckAfter, true, "滚动后应带上 is-stuck");
assert.ok(/gradient/.test(r.shadowAfter), `滚动后应有渐隐投影，实得 ${r.shadowAfter}`);
assert.notEqual(r.headShadowAfter, "none", "滚动后应有一条细亮分隔线");

/* 层级不变式 */
const z = r.zLayers;
assert.ok(z.cardHover !== null, "没读到 .material-card:hover 的 z-index，层级断言失效");
assert.ok(z.head > z.cardHover, `吸顶条 z-index(${z.head}) 必须大于卡片悬停层(${z.cardHover})，否则悬停卡片会盖住头部`);
assert.ok(z.drawer === null || z.head < z.drawer, `吸顶条不应压过设置抽屉(${z.drawer})，实得 ${z.head}`);
assert.ok(z.about === null || z.head < z.about, `吸顶条不应压过关于弹窗遮罩(${z.about})，实得 ${z.head}`);

console.log("[PASS] 素材页路径栏吸顶：滚动位置不变、铺底遮挡到位、间距保持、滚动投影生效、层级正确");
