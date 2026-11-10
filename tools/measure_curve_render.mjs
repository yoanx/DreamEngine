#!/usr/bin/env node
/* ============================================================
 * measure_curve_render.mjs —— 曲线编辑视图的真渲染实测
 *
 * 用无头 Chrome 加载**真实的 index.html + curve_math.js + curve.js +
 * library.js + style.css**，只把 Bridge 的 AE 通道换成桩：
 *   · snapshotJson 返回一份真实结构的快照
 *   · applyText 记录面板下发的文本协议并返回可切换的结果
 * 然后派发真实的鼠标事件、点真实的预设卡片与「应用」按钮。
 *
 * 这一版验的是新的工作流（曲线模板 + 应用）：
 *   · 进入视图、选预设、拖把手，**一次 AE 都不读、不写**
 *   · 只有按「应用」才读快照并写回，写回文本覆盖每条属性的每一段
 *   · 写成功后自动重读一次，灰色参考反映 AE 真实值
 *
 * 用法：node tools/measure_curve_render.mjs
 * ============================================================ */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
const SIM = resolve(PANEL, "__sim_curve.html");

function findChrome() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}
const browser = findChrome();
if (!browser) {
  console.log("跳过：找不到 Chrome / Edge");
  process.exit(0);
}

/* ---------- 快照桩：结构与 curvelib 的 snapshotJson 一致 ---------- */

function keyFrame(i, t, v, opts) {
  const o = opts || {};
  const fill = (n) => v.map(() => n);
  return {
    i, t, v,
    tin: o.tin === undefined ? 2 : o.tin,
    tout: o.tout === undefined ? 2 : o.tout,
    is: o.is || fill(0),
    ii: o.ii || fill(33.33),
    os: o.os || fill(0),
    oi: o.oi || fill(33.33),
    it: o.it || fill(0),
    ot: o.ot || fill(0),
    ab: false, co: true, rv: false,
  };
}

/* 位置在前：面板默认看第 0 条属性，它决定「路」能不能用 */
const positionProp = {
  i: 0,
  loc: "M4Sim|m4_2d|变换|位置",
  name: "位置",
  group: "变换",
  matchName: "ADBE Position",
  vt: 3, dims: 2, spatial: true, sep: false, n: 3,
  sig: "sig-b",
  keys: [
    keyFrame(0, 0, [300, 800], { ot: [120, -80] }),
    keyFrame(1, 1, [900, 300], { ot: [200, -150], it: [-200, -150] }),
    keyFrame(2, 2, [1700, 800], { it: [-120, 80] }),
  ],
};

const sliderProp = {
  i: 1,
  loc: "M4Sim|m4_1d|变换|滑杆",
  name: "滑杆",
  group: "变换",
  matchName: "ADBE Slider Control-0001",
  vt: 1, dims: 1, spatial: false, sep: false, n: 3,
  sig: "sig-a",
  keys: [
    keyFrame(0, 0, [0]),
    keyFrame(1, 1, [100], { os: [0], oi: [85] }),
    keyFrame(2, 2, [30]),
  ],
};

const SNAPSHOT = JSON.stringify({
  status: "ok",
  version: "1.0.0",
  ae: "21.0.0",
  comp: "M4Sim",
  time: 0.6,
  props: [positionProp, sliderProp],
});

/* 2 条属性 × 2 段 = 4 段 → expect 2 行 + out/in 8 行 */
const EXPECT_LINES = 2;
const EXPECT_OPS = 8;

/* ---------- 桩 ---------- */

const stub = `
<pre id="out"></pre>
<script>
window.__SIM_ERRORS = [];
window.addEventListener("error", function (e) { window.__SIM_ERRORS.push(String(e.message)); });
window.__SIM = { reads: 0, writes: [] };
window.__SIM_SNAPSHOT = ${JSON.stringify(SNAPSHOT)};
window.__SIM_APPLY = '{"status":"ok","applied":8,"skipped":[],"sigs":[]}';

Bridge.getExtensionPath = function (cb) { cb("file:///sim/panel"); };
Bridge.evalAE = function (jsx, cb) { if (cb) cb("__NOT_CEP__"); };
Bridge.getDocsPath = function (cb) { cb(""); };
Bridge.listFiles = function (dir, pat, cb) { cb("NO_DIR"); };
Bridge.runEngine = function (path, expr, cb) {
  var out = '{"status":"ok"}';
  try {
    if (expr.indexOf("AEV_Curve.snapshotJson") === 0) {
      window.__SIM.reads++;
      out = window.__SIM_SNAPSHOT;
    } else if (expr.indexOf("AEV_Curve.applyText") === 0) {
      var arg = expr.slice(expr.indexOf("(") + 1, expr.lastIndexOf(")"));
      var text = "";
      try { text = JSON.parse(arg); } catch (e) { text = String(arg); }
      window.__SIM.writes.push({ text: text });
      out = window.__SIM_APPLY;
    } else if (expr.indexOf("AEV_Queue.stats") === 0) {
      out = '{"total":0,"pending":0,"rendering":0,"cached":0,"failed":0}';
    } else if (expr.indexOf("AEV_Presets.listJson") === 0) {
      out = '{"status":"ok","items":[],"folder":""}';
    } else if (expr.indexOf("AEV_PreviewGen.staleList") === 0) {
      out = '{"stale":[]}';
    }
  } catch (e) { out = "ERR:" + e; }
  if (cb) setTimeout(function () { cb(out); }, 0);
};
</script>
`;

/* ---------- 探测脚本：驱动真实交互 ---------- */

const probe = `
<script>
var R = {};
var canvas, rect;

function wait(ms, fn) { setTimeout(fn, ms); }

function paintedPixels() {
  var c = document.getElementById("curveCanvas");
  var g = c.getContext("2d");
  var img = g.getImageData(0, 0, c.width, c.height).data;
  var n = 0;
  for (var i = 3; i < img.length; i += 4) if (img[i] > 8) n++;
  return n;
}

function mouseAt(type, x, y) {
  var target = type === "mouseup" ? document : canvas;
  target.dispatchEvent(new MouseEvent(type, {
    clientX: rect.left + x,
    clientY: rect.top + y,
    bubbles: true,
    button: 0,
    buttons: type === "mouseup" ? 0 : 1
  }));
}

function clickPreset(id) {
  var chips = document.querySelectorAll("#curvePresets .preset-chip");
  for (var i = 0; i < chips.length; i++) {
    if (chips[i].getAttribute("data-pid") === id) { chips[i].click(); return true; }
  }
  return false;
}

function dragHandle() {
  var snap = AEV_CurveUI.snapshot();
  if (!snap.handle) { R.error = "没有把手坐标"; return false; }
  mouseAt("mousedown", snap.handle.x, snap.handle.y);
  mouseAt("mousemove", snap.handle.x + 14, snap.handle.y + 8);
  mouseAt("mousemove", snap.handle.x + 26, snap.handle.y + 16);
  R.writesDuringDrag = window.__SIM.writes.length;
  R.readsDuringDrag = window.__SIM.reads;
  mouseAt("mouseup", snap.handle.x + 26, snap.handle.y + 16);
  R.afterDrag = AEV_CurveUI.snapshot();
  return true;
}

function run() {
  R.errors = window.__SIM_ERRORS;

  document.getElementById("tabCurve").click();

  wait(400, function () {
    R.viewCurveHidden = document.getElementById("viewCurve").hidden;
    R.viewCurveVisible = document.getElementById("viewCurve").getBoundingClientRect().height > 0;
    R.effectsVisible = document.getElementById("viewEffects").getBoundingClientRect().height > 0;
    R.painted = paintedPixels();
    R.initial = AEV_CurveUI.snapshot();
    R.readsOnEnter = window.__SIM.reads;
    R.writesOnEnter = window.__SIM.writes.length;
    R.chipCount = document.querySelectorAll("#curvePresets .preset-chip").length;
    R.presetChips = document.querySelectorAll("#curvePresets .preset-chip[data-pid]").length;
    R.saveButton = !!document.getElementById("curvePresetSaveOpen");
    R.actionLayout = (function () {
      var apply = document.getElementById("curveApply").getBoundingClientRect();
      var save = document.getElementById("curvePresetSaveOpen").getBoundingClientRect();
      var row = document.querySelector(".curve-action-row").getBoundingClientRect();
      return {
        rowLeft: row.left,
        rowRight: row.right,
        applyTop: apply.top,
        applyRight: apply.right,
        saveTop: save.top,
        saveLeft: save.left,
        saveWidth: save.width
      };
    })();
    R.labelLayout = (function () {
      var chip = document.querySelector('#curvePresets .preset-chip[data-pid="ease-in-out"]');
      if (!chip) return null;
      var span = chip.querySelector("span");
      var style = getComputedStyle(span);
      return {
        whiteSpace: style.whiteSpace,
        lineClamp: style.webkitLineClamp,
        height: span.getBoundingClientRect().height,
        scrollWidth: span.scrollWidth,
        clientWidth: span.clientWidth
      };
    })();
    R.chipHasCurve = (function () {
      var cv = document.querySelector("#curvePresets .preset-chip canvas");
      if (!cv) return 0;
      var d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      var n = 0;
      for (var i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
      return n;
    })();
    R.hint = String(document.getElementById("curveHint").textContent);
    R.hasReloadBtn = !!document.getElementById("curveConflictReload");

    /* 视图比例只改本地绘图区，不读也不写 AE。 */
    R.viewToggle = (function () {
      var toggle = document.getElementById("curveViewToggle");
      if (!toggle) return { exists: false };
      var before = AEV_CurveUI.snapshot();
      if (before.view === "square") toggle.click();
      var fill = AEV_CurveUI.snapshot();
      var readsBefore = window.__SIM.reads;
      toggle.click();
      var square = AEV_CurveUI.snapshot();
      var result = {
        exists: true,
        fill: fill.view,
        square: square.view,
        squarePressed: toggle.getAttribute("aria-pressed"),
        squareRatio: square.mapRect ? square.mapRect.w / square.mapRect.h : 0,
        storedSquare: String(localStorage.getItem("dreamengine.curve.view.v1") || ""),
        readsDuringToggle: window.__SIM.reads - readsBefore
      };
      toggle.click();
      result.restored = AEV_CurveUI.snapshot().view;
      result.pressedAfterRestore = toggle.getAttribute("aria-pressed");
      return result;
    })();

    canvas = document.getElementById("curveCanvas");
    rect = canvas.getBoundingClientRect();

    /* 1) 点预设：只改模板 */
    R.presetClicked = clickPreset("back-out");
    R.afterPreset = AEV_CurveUI.snapshot();
    R.readsAfterPreset = window.__SIM.reads;
    R.writesAfterPreset = window.__SIM.writes.length;

    /* 2) 拖把手：仍然不读不写 */
    if (!dragHandle()) { finish(); return; }

    /* 3) 应用：这时才读快照并写回 */
    window.__SIM_APPLY = '{"status":"ok","applied":8,"skipped":[],"sigs":[]}';
    document.getElementById("curveApply").click();

    wait(400, function () {
      R.writesAfterApply = window.__SIM.writes.length;
      R.applyText = window.__SIM.writes.length ? window.__SIM.writes[0].text : "";
      R.readsAfterApply = window.__SIM.reads;
      R.afterApply = AEV_CurveUI.snapshot();
      /* 应用改成图标按钮后没有可见文本，忙碌状态写在 aria-label 上 */
      R.applyBtnText = String(document.getElementById("curveApply").getAttribute("aria-label") || "");
      R.applyBtnDisabled = document.getElementById("curveApply").disabled;

      /* 4) 冲突：第二次应用被拒 → 弹框 → 覆盖 */
      window.__SIM_APPLY = '{"status":"conflict","reason":"changed","loc":"M4Sim|m4_2d|变换|位置","sig":"sig-z"}';
      document.getElementById("curveApply").click();

      wait(300, function () {
        R.conflictVisible = !document.getElementById("curveConflict").hidden;
        R.conflictText = String(document.getElementById("curveConflictText").textContent);

        window.__SIM_APPLY = '{"status":"ok","applied":8,"skipped":[],"sigs":[]}';
        document.getElementById("curveConflictOverwrite").click();

        wait(300, function () {
          R.writesAfterOverwrite = window.__SIM.writes.length;
          R.overwriteText = window.__SIM.writes.length
            ? window.__SIM.writes[window.__SIM.writes.length - 1].text : "";
          R.conflictHiddenAfter = document.getElementById("curveConflict").hidden;

          /* 5) 速/路：应用后才有数据可用 */
          var pathBtn = document.getElementById("curveModePath");
          R.pathEnabledAfterApply = !pathBtn.disabled;
          document.getElementById("curveModeSpeed").click();
          R.modeAfterSpeed = AEV_CurveUI.snapshot().mode;
          R.paintedSpeed = paintedPixels();

          pathBtn.click();
          R.modeAfterPath = AEV_CurveUI.snapshot().mode;
          R.paintedPath = paintedPixels();

          document.getElementById("curveModeValue").click();
          R.modeBackToValue = AEV_CurveUI.snapshot().mode;
          R.paintedBack = paintedPixels();

          /* 6) 写回被 AE 抛异常：必须把原始 detail 与属性名一起显示出来，
                只报一个 write_failed 等于没说 */
          window.__SIM_APPLY =
            '{"status":"error","reason":"write_failed","detail":"bad ease array","loc":"M4Sim|m4_2d|变换|位置"}';
          document.getElementById("curveApply").click();

          wait(300, function () {
            R.failMsg = String(document.getElementById("curveHint").textContent);
            R.failClass = document.getElementById("curveHint").className;
            var add = document.getElementById("curvePresetSaveOpen");
            R.hasPresetAdd = !!add;
            if (!add) { finish(); return; }

            add.click();
            R.saveDialogVisible = !document.getElementById("curvePresetSaveDialog").hidden;
            var nameInput = document.getElementById("curvePresetName");
            nameInput.value = "我的曲线";
            document.getElementById("curvePresetSaveConfirm").click();
            R.afterSave = AEV_CurveUI.snapshot();
            R.customChip = document.querySelector('#curvePresets .preset-chip[data-pid^="custom-"]');
            R.customName = R.customChip ? String(R.customChip.textContent) : "";
            try {
              R.customStored = String(localStorage.getItem("dreamengine.curve.customPresets.v1") || "")
                .indexOf("我的曲线") >= 0;
            } catch (e) { R.customStored = false; }

            function holdPreset(chip, done) {
              if (!chip) { done(); return; }
              chip.dispatchEvent(new PointerEvent("pointerdown", {
                bubbles: true, button: 0, pointerId: 1
              }));
              setTimeout(function () {
                chip.dispatchEvent(new PointerEvent("pointerup", {
                  bubbles: true, button: 0, pointerId: 1
                }));
                done();
              }, 750);
            }

            var smooth = document.querySelector('#curvePresets .preset-chip[data-pid="smooth"]');
            holdPreset(smooth, function () {
              R.deleteDialogVisible = !document.getElementById("curvePresetDeleteDialog").hidden;
              R.deleteText = String(document.getElementById("curvePresetDeleteText").textContent);
              smooth.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
              R.activeAfterLongPress = AEV_CurveUI.snapshot().activeChip;
              document.getElementById("curvePresetDeleteConfirm").click();
              R.afterBuiltinDelete = AEV_CurveUI.snapshot();
              R.smoothStillThere = !!document.querySelector('#curvePresets .preset-chip[data-pid="smooth"]');
              try {
                R.deletedStored = String(localStorage.getItem("dreamengine.curve.deletedPresets.v1") || "")
                  .indexOf("smooth") >= 0;
              } catch (e2) { R.deletedStored = false; }

              var custom = document.querySelector('#curvePresets .preset-chip[data-pid^="custom-"]');
              holdPreset(custom, function () {
                document.getElementById("curvePresetDeleteConfirm").click();
                R.afterCustomDelete = AEV_CurveUI.snapshot();
                R.customStillThere = !!document.querySelector('#curvePresets .preset-chip[data-pid^="custom-"]');
                try {
                  R.customStoredAfterDelete = String(localStorage.getItem("dreamengine.curve.customPresets.v1") || "")
                    .indexOf("我的曲线") >= 0;
                } catch (e3) { R.customStoredAfterDelete = true; }
                finish();
              });
            });
          });
        });
      });
    });
  });
}

function finish() {
  R.errorsFinal = window.__SIM_ERRORS;
  document.getElementById("out").textContent = JSON.stringify(R);
}

wait(1200, run);
</script>
`;

const html = readFileSync(resolve(PANEL, "index.html"), "utf8").replace("</body>", `${stub}\n${probe}\n</body>`);
writeFileSync(SIM, html, "utf8");

let dom = "";
try {
  dom = execFileSync(
    browser,
    [
      "--headless",
      "--disable-gpu",
      "--allow-file-access-from-files",
      "--dump-dom",
      "--virtual-time-budget=14000",
      "file:///" + SIM.replace(/\\/g, "/"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
} finally {
  if (process.env.KEEP_SIM !== "1") {
    try { unlinkSync(SIM); } catch (e) {}
  } else {
    console.log("模拟页已保留：" + SIM);
  }
}

const block = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!block) {
  console.error("没拿到测量结果（面板脚本可能报错了）");
  process.exit(1);
}
const data = JSON.parse(block[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log("[PASS] " + name);
  } catch (e) {
    failed++;
    console.log("[FAIL] " + name);
    console.log("       " + String(e.message || e).split("\n").slice(0, 4).join("\n       "));
  }
}

const lines = String(data.applyText || "").split("\n");
const expectCount = lines.filter((l) => l.indexOf("expect\t") === 0).length;
const opCount = lines.filter((l) => /^(out|in)\t/.test(l)).length;

console.log("=== 曲线编辑器真渲染实测（Flow 式工作流）===");
console.log("画布着色 " + data.painted + " ｜ 预设卡片 " + data.chipCount +
  "（缩略图着色 " + data.chipHasCurve + "）｜ 提示：" + data.hint);
console.log("读数：进入 " + data.readsOnEnter + " 次 ｜ 选预设后 " + data.readsAfterPreset +
  " ｜ 拖拽后 " + data.readsDuringDrag + " ｜ 应用后 " + data.readsAfterApply);
console.log("写回：" + data.writesAfterApply + " 次（expect " + expectCount + " 行 / out+in " + opCount + " 行）");
console.log("操作行：" + JSON.stringify(data.actionLayout));
console.log("页面错误：" + JSON.stringify(data.errorsFinal || []));
console.log("");

check("切到曲线视图后真的可见，效果墙不可见", () => {
  assert.equal(data.viewCurveHidden, false, "viewCurve 仍是 hidden");
  assert.equal(data.viewCurveVisible, true, "curve-view 不可见（[hidden] 被 CSS 盖掉？）");
  assert.equal(data.effectsVisible, false, "效果墙还占着位置");
});

check("曲线面板常驻：进入视图不读 AE，画布已经画好", () => {
  assert.equal(data.readsOnEnter, 0, "进入视图就读了快照：" + data.readsOnEnter);
  assert.equal(data.writesOnEnter, 0, "进入视图就写了 AE");
  assert.ok(data.painted > 300, "画布几乎没有着色像素：" + data.painted);
  assert.equal(data.initial.mode, "value", "默认应停在值图");
  assert.ok(data.initial.handle, "没有算出把手坐标");
});

check("曲线画布可在填充与正方形之间切换，且不触碰 AE", () => {
  assert.equal(data.viewToggle.exists, true, "缺少视图切换按钮");
  assert.equal(data.viewToggle.fill, "fill", "填充视图状态不对");
  assert.equal(data.viewToggle.square, "square", "正方形视图状态不对");
  assert.equal(data.viewToggle.squarePressed, "true", "正方形视图没有暴露按下状态");
  assert.ok(Math.abs(data.viewToggle.squareRatio - 1) < 1e-6,
    "正方形视图的绘图区不是正方形：" + data.viewToggle.squareRatio);
  assert.equal(data.viewToggle.storedSquare, "square", "视图选择没有写入本地存储");
  assert.equal(data.viewToggle.readsDuringToggle, 0, "切换视图不应该读取 AE");
  assert.equal(data.viewToggle.restored, "fill", "再次点击没有恢复填充视图");
  assert.equal(data.viewToggle.pressedAfterRestore, "false", "恢复填充后按下状态不对");
});

check("预设以曲线缩略图列在下面，保存按钮在应用右侧且文字两行布局正确", () => {
  assert.equal(data.initial.presets, 18, "预设条数不对：" + data.initial.presets);
  /* 15 条两点内置 + 3 条多点内置（g-two-stage / g-accel / g-hold） */
  assert.equal(data.presetChips, 18, "预设卡片数量不对：" + data.presetChips);
  assert.equal(data.chipCount, 18, "保存按钮不该混在预设卡片网格里：" + data.chipCount);
  assert.equal(data.saveButton, true, "没有「保存当前」按钮");
  assert.ok(Math.abs(data.actionLayout.applyTop - data.actionLayout.saveTop) <= 1,
    "保存按钮与应用不在同一行：" + JSON.stringify(data.actionLayout));
  assert.ok(data.actionLayout.saveLeft >= data.actionLayout.applyRight,
    "保存按钮不在应用右侧：" + JSON.stringify(data.actionLayout));
  /* 保存按钮改成了图标按钮（38px 定宽），不再是 88px 的文字按钮 */
  assert.ok(data.actionLayout.saveWidth >= 28, "保存按钮过窄：" + data.actionLayout.saveWidth);
  assert.ok(data.actionLayout.saveLeft + data.actionLayout.saveWidth <= data.actionLayout.rowRight + 1,
    "保存按钮溢出操作行：" + JSON.stringify(data.actionLayout));
  assert.ok(data.chipHasCurve > 30, "缩略图 canvas 几乎是空的：" + data.chipHasCurve);
  assert.equal(data.labelLayout.whiteSpace, "normal", "预设名称仍然禁止换行");
  assert.equal(data.labelLayout.lineClamp, "2", "预设名称没有限制为两行");
  assert.ok(data.labelLayout.height >= 20, "预设名称没有获得两行高度");
  assert.ok(data.labelLayout.scrollWidth <= data.labelLayout.clientWidth + 1,
    "预设名称仍在横向溢出：" + JSON.stringify(data.labelLayout));
});

check("点预设只换模板：不读 AE、不写 AE", () => {
  assert.equal(data.presetClicked, true, "没找到 back-out 卡片");
  assert.equal(data.readsAfterPreset, 0, "点预设时读了 AE");
  assert.equal(data.writesAfterPreset, 0, "点预设时写了 AE");
  assert.equal(data.afterPreset.preset, "back-out", "预设没被记住");
  assert.equal(data.afterPreset.activeChip, "back-out", "卡片没有高亮");
  assert.ok(data.afterPreset.curve.y2 > 1.2,
    "back-out 的 y2 应大于 1.2（回弹），实际 " + data.afterPreset.curve.y2);
});

check("拖把手只改本地曲线：全程不过桥", () => {
  assert.equal(data.readsDuringDrag, 0, "拖拽时读了 AE");
  assert.equal(data.writesDuringDrag, 0, "拖拽时写了 AE");
  const before = data.afterPreset.curve;
  const after = data.afterDrag.curve;
  assert.ok(after.x1 !== before.x1 || after.y1 !== before.y1, "拖拽没有改变曲线");
  assert.equal(data.afterDrag.preset, "", "手动拖过之后还挂着预设高亮");
});

check("按「应用」才读快照，写回覆盖每条属性的每一段", () => {
  assert.equal(data.writesAfterApply, 1, "应用没有写回：" + data.writesAfterApply);
  assert.equal(expectCount, EXPECT_LINES, "expect 行数不对：" + expectCount);
  assert.equal(opCount, EXPECT_OPS, "out/in 行数不对：" + opCount);
  const first = lines[1].split("\t");
  assert.match(lines[1], /^(out|in)\t/, "第一条不是 ease 操作：" + lines[1]);
  assert.ok(Number.isFinite(Number(first[3])), "influence 不是数字：" + first[3]);
  assert.ok(Number.isFinite(Number(first[4])), "m 不是数字：" + first[4]);
});

check("写成功后自动重读一次，按钮恢复可用", () => {
  assert.equal(data.readsAfterApply, 2, "应用后应读 2 次（apply + 对齐），实际 " + data.readsAfterApply);
  assert.equal(data.afterApply.hasSnap, true, "快照没有留下");
  assert.equal(data.applyBtnDisabled, false, "按钮还禁着");
  assert.match(String(data.applyBtnText), /应用|Apply/, "按钮文案没恢复：" + data.applyBtnText);
});

check("并发冲突弹框，只有覆盖 / 放弃两个选项", () => {
  assert.equal(data.conflictVisible, true, "冲突没有弹框");
  assert.match(String(data.conflictText), /改过|changed/, "冲突文案不对：" + data.conflictText);
  assert.equal(data.hasReloadBtn, false, "不该再有「重新载入」按钮");
});

check("点「覆盖」重发时带 force 且去掉 expect 行", () => {
  // 三次 applyText 调用：正常 1 + 撞冲突 1（桩也记了一次）+ 覆盖重发 1
  assert.equal(data.writesAfterOverwrite, 3, "覆盖没有重发（期望 3 次调用），实际 " + data.writesAfterOverwrite);
  const text = String(data.overwriteText || "");
  assert.match(text.split("\n")[0], /^force$/, "首行不是 force：" + text.split("\n")[0]);
  assert.equal(text.split("\n").filter((l) => l.indexOf("expect\t") === 0).length, 0,
    "覆盖时仍带 expect 行");
  assert.equal(data.conflictHiddenAfter, true, "覆盖后对话框没关");
});

check("速 / 路是只读检查：应用后可用，切回值图能编辑", () => {
  assert.equal(data.pathEnabledAfterApply, true, "空间属性应用后路径图应可用");
  assert.equal(data.modeAfterSpeed, "speed", "没切到速度图");
  assert.ok(data.paintedSpeed > 300, "速度图没画出来：" + data.paintedSpeed);
  assert.equal(data.modeAfterPath, "path", "没切到路径图");
  assert.ok(data.paintedPath > 300, "路径图没画出来：" + data.paintedPath);
  assert.equal(data.modeBackToValue, "value", "没切回值图");
  assert.ok(data.paintedBack > 300, "切回值图后没画出来：" + data.paintedBack);
});

check("写回抛异常时，detail 与属性名都要显示出来", () => {
  const msg = String(data.failMsg || "");
  assert.match(msg, /bad ease array/, "没显示 AE 的原始异常：" + msg);
  assert.match(msg, /位置/, "没指出是哪条属性：" + msg);
  assert.match(String(data.failClass || ""), /error/, "提示没有标成错误态");
});

check("保存当前曲线为自定义预设", () => {
  assert.equal(data.hasPresetAdd, true, "没有保存入口");
  assert.equal(data.saveDialogVisible, true, "保存弹窗没有出现");
  assert.equal(data.afterSave.preset.indexOf("custom-"), 0, "保存后没有选中自定义预设");
  assert.ok(data.customChip, "自定义预设没有进入同一网格");
  assert.match(data.customName, /我的曲线/, "自定义预设名称没显示");
  assert.equal(data.afterSave.presets, data.initial.presets + 1, "保存后预设数量不对");
  assert.equal(data.customStored, true, "自定义预设没有写入本地存储");
});

check("长按删除自带预设和自定义预设", () => {
  assert.equal(data.deleteDialogVisible, true, "长按没有弹删除确认");
  assert.match(String(data.deleteText), /平滑/, "删除确认没有显示预设名");
  assert.ok(String(data.activeAfterLongPress).indexOf("custom-") === 0,
    "长按松手后的 click 误选了被长按预设");
  assert.equal(data.smoothStillThere, false, "确认后自带预设仍在");
  assert.equal(data.afterBuiltinDelete.presets, data.initial.presets, "删除自带预设后数量不对");
  assert.equal(data.deletedStored, true, "自带预设的删除状态没有持久化");
  assert.equal(data.customStillThere, false, "确认后自定义预设仍在");
  assert.equal(data.afterCustomDelete.presets, data.initial.presets - 1, "删除自定义预设后数量不对");
  assert.equal(data.customStoredAfterDelete, false, "自定义预设没有从本地存储删除");
});

check("全流程没有 JS 错误", () => {
  assert.equal((data.errorsFinal || []).length, 0, String((data.errorsFinal || []).join("; ")));
});

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}`);
if (failed > 0) process.exitCode = 1;
