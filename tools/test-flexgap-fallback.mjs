#!/usr/bin/env node
/* ============================================================
 * test-flexgap-fallback.mjs —— flex gap 兜底回归
 *
 * 背景：Chromium 74（AE 2021 / CEP 11）不支持 flex 容器的 gap，
 * 而 CSS.supports("gap") 会误报 true，只能用运行时测量判断（js/compat.js）。
 *
 * 本测试验两件事，缺一不可：
 *   1. 旧内核路径：给 <html> 打 .no-flex-gap 且把所有 gap 清零，
 *      兜底规则必须补出与原设计等值的间距 —— 尤其不能覆盖 margin-left:auto
 *   2. 新内核路径：compat.js 不得误判，否则现代内核会「gap + margin」双倍间距
 *
 * 用 Chrome/Edge 无头跑，找不到浏览器则跳过（与本仓库其他 UI 测试一致）。
 * ============================================================ */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");

function findBrowser() {
  return [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((path) => existsSync(path)) || "";
}

const browser = findBrowser();
if (!browser) {
  console.log("skip: Chrome/Edge not found");
  process.exit(0);
}

function runPage(name, html, extract) {
  const file = resolve(PANEL, `__sim_${name}.html`);
  writeFileSync(file, html, "utf8");
  let dom = "";
  try {
    dom = execFileSync(
      browser,
      [
        "--headless",
        "--disable-gpu",
        "--window-size=600,400",
        "--allow-file-access-from-files",
        "--dump-dom",
        "--virtual-time-budget=4000",
        "file:///" + file.replace(/\\/g, "/"),
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
    );
  } finally {
    unlinkSync(file);
  }
  return extract(dom);
}

/* ---------- 1. 旧内核路径：兜底规则落位 ---------- */
const legacyScript = `
document.documentElement.className += " no-flex-gap";
function rc(el, name) {
  if (!el) throw new Error("缺少元素: " + name);
  return el.getBoundingClientRect();
}
var out = {};
// 顶栏：gap 20，且 .view-switch 自身还有 margin-left:4 → 应为 24
out.viewSwitch = Math.round(
  rc(document.querySelector(".view-switch"), "view-switch").left -
  rc(document.querySelector(".brand-name"), "brand-name").right
);
// search-wrap 靠 margin-left:auto 推到右侧，兜底不能把它变成定值
out.searchToButton = Math.round(
  rc(document.getElementById("btnSettings"), "btn").left -
  rc(document.querySelector(".search-wrap"), "search-wrap").right
);
// 文件夹计数同样靠 auto 贴右
var frow = document.getElementById("frow");
out.countRight = Math.round(
  rc(frow, "frow").right - rc(frow.querySelector(".material-folder-count"), "count").right
);
// 行内小间距：文件行的 stem 与扩展名之间应为 4
var firow = document.getElementById("firow");
out.stemToExt = Math.round(
  rc(firow.querySelector(".material-file-ext"), "ext").left -
  rc(firow.querySelector(".material-file-stem"), "stem").right
);
// 列方向：settings-drawer gap 10 + group 自身 16 下边距 = 26
var groups = document.querySelectorAll("#sd .settings-group");
out.drawer = Math.round(rc(groups[1], "g1").top - rc(groups[0], "g0").bottom);
document.getElementById("out").textContent = "RESULT=" + JSON.stringify(out);
`;

const legacyHtml = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<link rel="stylesheet" href="css/style.css"/>
<style>
  /* 现代浏览器本来有 flex gap；清零以模拟旧内核，
     剩下的间距只能来自 .no-flex-gap 兜底规则。 */
  * { gap: 0 !important; }
</style></head>
<body>
<header class="topbar">
  <button class="brand-mark" type="button">M</button>
  <span class="brand-name">DreamEngine</span>
  <nav class="view-switch"><button class="view-tab">效果</button><button class="view-tab">预设</button></nav>
  <div class="search-wrap"><button class="icon-button">s</button></div>
  <button class="icon-button" id="btnSettings">g</button>
</header>
<div class="material-folder-row" id="frow" style="width:200px">
  <span class="material-name">教程</span><span class="material-folder-count">70 项</span>
</div>
<div class="material-file-row" id="firow" style="width:200px">
  <span class="material-file-stem">stem</span><span class="material-file-ext">png</span>
</div>
<div class="settings-drawer" id="sd">
  <div class="settings-group">A</div><div class="settings-group">B</div>
</div>
<pre id="out"></pre>
<script>${legacyScript}</script>
</body></html>`;

const legacy = runPage("flexgap", legacyHtml, (dom) => {
  const pre = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
  assert.ok(pre, "输出容器缺失");
  const text = pre[1].trim();
  assert.ok(text.indexOf("RESULT=") === 0, `页面脚本异常：${text.slice(0, 160)}`);
  return JSON.parse(text.slice(7));
});

assert.equal(legacy.viewSwitch, 24, `顶栏 view-switch 间距应为 20(gap)+4(自身 margin)=24，实得 ${legacy.viewSwitch}`);
assert.equal(legacy.searchToButton, 20, `search-wrap 应被 auto 推到右侧，与设置按钮相距 20，实得 ${legacy.searchToButton}`);
assert.equal(legacy.countRight, 0, `文件夹计数应贴右（auto 未被覆盖），实得距右 ${legacy.countRight}px`);
assert.equal(legacy.stemToExt, 4, `文件行 stem→ext 间距应为 4，实得 ${legacy.stemToExt}`);
assert.ok(legacy.drawer >= 10, `settings-drawer 垂直间距应 >= 10，实得 ${legacy.drawer}`);

/* ---------- 2. 新内核路径：不得误判 ---------- */
const compatHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<script src="js/compat.js"></script></head><body><pre id="out"></pre>
<script>
  document.getElementById("out").textContent = "CLASS=[" + document.documentElement.className + "]";
</script></body></html>`;

const htmlClass = runPage("compat", compatHtml, (dom) => {
  const m = dom.match(/CLASS=\[([^\]]*)\]/);
  assert.ok(m, "compat 输出缺失");
  return m[1].trim();
});

assert.equal(htmlClass, "", "现代内核不应加 .no-flex-gap，否则会与 gap 叠加成双倍间距");

console.log("[PASS] flex gap 兜底：旧内核间距等值、auto 边距保留、新内核不误判");
