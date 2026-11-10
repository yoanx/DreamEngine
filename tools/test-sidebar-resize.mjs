#!/usr/bin/env node
/* Drag behavior for the resizable effect and preset category sidebars. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
const SIM = resolve(PANEL, "__sim_sidebar_resize.html");

function findChrome() {
  return [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ].find((path) => existsSync(path)) || "";
}

const browser = findChrome();
if (!browser) {
  console.log("skip: Chrome/Edge not found");
  process.exit(0);
}

const probe = `
<pre id="out"></pre>
<script>
window.addEventListener("error", function (event) {
  document.getElementById("out").textContent = JSON.stringify({
    error: String(event.message || event.error || "unknown script error")
  });
});
</script>
<script>
localStorage.setItem("dreamengine.uiLayout.v1", JSON.stringify({
  sidebarWidths: { presets: 146 }
}));
</script>
<script src="js/prefs.js"></script>
<script src="js/sidebar_resize.js"></script>
<script>
function waitFrame() {
  return new Promise(function (resolve) {
    setTimeout(resolve, 30);
  });
}
function drag(handle, delta) {
  var box = handle.getBoundingClientRect();
  var startX = box.left + box.width / 2;
  handle.dispatchEvent(new MouseEvent("mousedown", {
    bubbles: true, cancelable: true, clientX: startX, buttons: 1
  }));
  document.dispatchEvent(new MouseEvent("mousemove", {
    bubbles: true, cancelable: true, clientX: startX + delta, buttons: 1
  }));
  document.dispatchEvent(new MouseEvent("mouseup", {
    bubbles: true, cancelable: true, clientX: startX + delta
  }));
}
async function run() {
  var result = {};
  try {
    var views = {
      effects: document.getElementById("viewEffects"),
      presets: document.getElementById("viewPresets")
    };
    var deltas = { effects: 46, presets: -28 };
    var after = {};
    var initialPresets = 0;
    for (var kind of ["effects", "presets"]) {
      for (var other in views) views[other].hidden = other !== kind;
      await waitFrame();
      var view = views[kind];
      var handle = view.querySelector('[data-sidebar-kind="' + kind + '"]');
      if (!handle) throw new Error("missing resizer: " + kind);
      var aside = view.querySelector(".sidebar, .preset-sidebar, .materials-sidebar");
      var main = kind === "presets" ? view.querySelector(".preset-main") : view.querySelector("main");
      var before = aside.getBoundingClientRect().width;
      if (kind === "presets") initialPresets = before;
      drag(handle, deltas[kind]);
      await waitFrame();
      after[kind] = {
        aside: aside.getBoundingClientRect().width,
        main: main.getBoundingClientRect().width,
        stored: AEV_Prefs.sidebarWidth(kind),
        now: Number(handle.getAttribute("aria-valuenow"))
      };
    }

    for (var other in views) views[other].hidden = other !== "effects";
    await waitFrame();
    var wideHandle = views.effects.querySelector('[data-sidebar-kind="effects"]');
    var wideAside = views.effects.querySelector(".sidebar");
    var wideMain = views.effects.querySelector("main");
    drag(wideHandle, 2000);
    await waitFrame();
    result.maxDrag = {
      aside: wideAside.getBoundingClientRect().width,
      main: wideMain.getBoundingClientRect().width
    };

    result.handles = document.querySelectorAll("[data-sidebar-resizer]").length;
    result.after = after;
    result.deltas = deltas;
    result.initialPresets = initialPresets;
  } catch (error) {
    result.error = String(error && (error.stack || error.message || error));
  }
  document.getElementById("out").textContent = JSON.stringify(result);
}
setTimeout(run, 200);
</script>`;

const html = readFileSync(resolve(PANEL, "index.html"), "utf8")
  .replace(/<meta\b[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "")
  .replace(/<script\b[\s\S]*?<\/script>/gi, "")
  .replace("</body>", probe + "</body>");
writeFileSync(SIM, html, "utf8");

let dom;
try {
  dom = execFileSync(
    browser,
    [
      "--headless",
      "--disable-gpu",
      "--allow-file-access-from-files",
      "--dump-dom",
      "--virtual-time-budget=6000",
      "file:///" + SIM.replace(/\\/g, "/"),
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
} finally {
  try { unlinkSync(SIM); } catch {}
}

const block = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
assert.ok(block && block[1].trim(), "sidebar resize harness returned no result");
const result = JSON.parse(block[1].replace(/&quot;/g, '"'));
assert.equal(result.error, undefined, result.error);
assert.equal(result.handles, 2);
assert.ok(
  Math.abs(result.initialPresets - 146) < 1.5,
  `hidden preset sidebar lost its saved width before first display (${result.initialPresets}px)`,
);
for (const kind of ["effects", "presets"]) {
  const row = result.after[kind];
  assert.ok(Math.abs(row.aside - row.stored) < 1.5, `${kind} sidebar width was not persisted`);
  assert.ok(Math.abs(row.aside - row.now) < 1.5, `${kind} aria-valuenow is stale`);
}
assert.notEqual(
  result.after.effects.stored,
  result.after.presets.stored,
  "the effect and preset sidebars must retain independent widths",
);
assert.ok(result.maxDrag.main >= 118, `main panel collapsed to ${result.maxDrag.main}px`);
console.log("[PASS] 效果与预设分类栏可独立拖动并保留各自宽度；素材分类栏固定");
