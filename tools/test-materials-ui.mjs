#!/usr/bin/env node
/* Headless DOM checks for the fixed material category rail and parent arrow. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
const SIM = resolve(PANEL, "__sim_materials_ui.html");

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
<script src="js/i18n.js"></script>
<script src="js/prefs.js"></script>
<script src="js/materials.js"></script>
<script>
function waitFrame() {
  return new Promise(function (resolve) { setTimeout(resolve, 30); });
}
async function run() {
  var result = {};
  try {
    var views = document.querySelectorAll(".workspace, .preset-view, .curve-view, .materials-view");
    for (var i = 0; i < views.length; i++) views[i].hidden = true;
    var view = document.getElementById("viewMaterials");
    view.hidden = false;

    localStorage.removeItem("dreamengine.favorites.v1");
    var ui = window.AEV_MaterialsUI;
    ui.state.root = "C:/Media";
    ui.state.dir = "C:/Media/sub";
    ui.state.items = [
      { path: "C:/Media/root.png", name: "root.png", type: "image", size: 40, exists: true },
      {
        path: "C:/Media/sub/a-very-long-video-file-name-that-needs-truncation.mp4",
        name: "a-very-long-video-file-name-that-needs-truncation.mp4",
        type: "video",
        size: 120,
        exists: true
      },
      { path: "C:/Media/sub/clip.mp4", name: "clip.mp4", type: "video", size: 100, exists: true },
      { path: "C:/Media/sub/deep/photo.png", name: "photo.png", type: "image", size: 50, exists: true }
    ];
    ui.state.loaded = true;
    ui.setLanguage("zh");
    await waitFrame();

    var aside = view.querySelector(".materials-sidebar");
    var buttons = view.querySelectorAll(".material-category-button");
    var ids = [];
    var allHaveIcons = true;
    var allUseSharedButtonClass = true;
    for (var b = 0; b < buttons.length; b++) {
      ids.push(buttons[b].getAttribute("data-category-id"));
      if (!buttons[b].querySelector("svg") || !buttons[b].getAttribute("aria-label")) allHaveIcons = false;
      if (!buttons[b].classList.contains("category-item")) allUseSharedButtonClass = false;
    }

    var grid = document.getElementById("materialGrid");
    var parent = grid.firstElementChild;
    result.rail = {
      width: aside.getBoundingClientRect().width,
      buttons: buttons.length,
      ids: ids,
      allHaveIcons: allHaveIcons,
      allUseSharedButtonClass: allUseSharedButtonClass,
      iconWidth: buttons.length
        ? getComputedStyle(buttons[0].querySelector("svg")).width
        : "",
      bottom: aside.getBoundingClientRect().bottom,
      lastButtonBottom: buttons.length
        ? buttons[buttons.length - 1].getBoundingClientRect().bottom
        : 0,
      oldLabels: view.querySelectorAll(".category-label").length,
      materialResizer: !!view.querySelector('[data-sidebar-kind="materials"]'),
      totalResizers: document.querySelectorAll("[data-sidebar-resizer]").length
    };
    result.parent = {
      first: parent && parent.classList.contains("material-parent"),
      card: !!(parent && parent.classList.contains("material-card")),
      icon: !!(parent && parent.querySelector("svg")),
      arrowWidth: parent && parent.querySelector("svg").getBoundingClientRect().width,
      cardWidth: parent && parent.getBoundingClientRect().width,
      label: parent && parent.getAttribute("aria-label"),
      title: parent && parent.title
    };
    var fileCard = grid.querySelector(".material-card:not(.folder)");
    var fileRow = fileCard && fileCard.querySelector(".material-file-row");
    var fileStem = fileCard && fileCard.querySelector(".material-file-stem");
    var fileExt = fileCard && fileCard.querySelector(".material-file-ext");
    var cardRect = fileCard && fileCard.getBoundingClientRect();
    var extRect = fileExt && fileExt.getBoundingClientRect();
    var fileBody = fileCard && fileCard.querySelector(".material-card-body");
    result.card = {
      hasRow: !!fileRow,
      stem: fileStem && fileStem.textContent,
      extension: fileExt && fileExt.textContent,
      oldMeta: !!(fileCard && fileCard.querySelector(".material-meta")),
      stemOverflow: fileStem && getComputedStyle(fileStem).textOverflow,
      stemTruncated: !!(fileStem && fileStem.scrollWidth > fileStem.clientWidth),
      extVisible: !!(extRect && extRect.width > 0 && extRect.height > 0),
      extInsideCard: !!(cardRect && extRect && extRect.right <= cardRect.right + 0.5),
      extBackground: fileExt && getComputedStyle(fileExt).backgroundColor,
      bodyHeight: fileBody && fileBody.getBoundingClientRect().height
    };
    var folderCard = grid.querySelector(".material-card.folder");
    var folderBody = folderCard && folderCard.querySelector(".material-card-body");
    var folderRow = folderCard && folderCard.querySelector(".material-folder-row");
    var folderName = folderCard && folderCard.querySelector(".material-name");
    var folderCount = folderCard && folderCard.querySelector(".material-folder-count");
    var folderNameRect = folderName && folderName.getBoundingClientRect();
    var folderCountRect = folderCount && folderCount.getBoundingClientRect();
    var folderRowRect = folderRow && folderRow.getBoundingClientRect();
    result.folder = {
      art: !!(folderCard && folderCard.querySelector(".material-folder-art")),
      sheets: folderCard ? folderCard.querySelectorAll(".material-folder-sheet").length : 0,
      back: !!(folderCard && folderCard.querySelector(".material-folder-back")),
      front: !!(folderCard && folderCard.querySelector(".material-folder-front")),
      oldIcon: !!(folderCard && folderCard.querySelector(".material-folder-icon")),
      hasRow: !!folderRow,
      name: folderName && folderName.textContent,
      count: folderCount && folderCount.textContent,
      sameLine: !!(folderNameRect && folderCountRect &&
        Math.abs(
          folderNameRect.top + folderNameRect.height / 2 -
          (folderCountRect.top + folderCountRect.height / 2)
        ) < 1.5),
      countRightAligned: !!(folderRowRect && folderCountRect &&
        folderRowRect.right - folderCountRect.right < 1),
      bodyHeight: folderBody && folderBody.getBoundingClientRect().height,
      nameOverflow: folderName && getComputedStyle(folderName).textOverflow
    };

    var videoButton = document.querySelector('[data-category-id="video"]');
    videoButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFrame();
    var activeVideoButton = document.querySelector('[data-category-id="video"]');
    result.categoryInteraction = {
      activeOnButton: activeVideoButton.classList.contains("active"),
      parentNotActive: !activeVideoButton.parentElement.classList.contains("active"),
      ariaPressed: activeVideoButton.getAttribute("aria-pressed"),
      activeCount: document.querySelectorAll(".material-category-button.active").length
    };
    document.querySelector('[data-category-id="all"]').dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    await waitFrame();

    parent.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFrame();
    result.afterSingle = ui.state.dir;
    parent.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await waitFrame();
    result.afterDouble = ui.state.dir;
    result.parentAfterDouble = !!document.querySelector("[data-material-parent]");

    ui.state.dir = "C:/Media/sub";
    ui.setLanguage("zh");
    await waitFrame();
    var keyboardParent = document.querySelector("[data-material-parent]");
    keyboardParent.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", bubbles: true, cancelable: true
    }));
    await waitFrame();
    result.afterKeyboard = ui.state.dir;
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
      "--window-size=455,600",
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
assert.ok(block && block[1].trim(), "materials UI harness returned no result");
const result = JSON.parse(block[1].replace(/&quot;/g, '"'));
assert.equal(result.error, undefined, result.error);
assert.equal(result.rail.width, 56);
assert.equal(result.rail.buttons, 7);
assert.equal(result.rail.oldLabels, 0);
assert.equal(result.rail.materialResizer, false);
assert.equal(result.rail.totalResizers, 2);
assert.equal(result.rail.allHaveIcons, true);
assert.equal(result.rail.allUseSharedButtonClass, true);
assert.equal(result.rail.iconWidth, "18px");
assert.ok(
  result.rail.lastButtonBottom <= result.rail.bottom,
  `全部素材分类应在图标轨道首屏内: ${JSON.stringify(result.rail)}`,
);
assert.ok(result.rail.ids.includes("script"), "脚本类别应出现在素材分类栏");
assert.ok(!result.rail.ids.includes("expression"), "表达式类别不应出现在素材分类栏");
assert.equal(result.parent.first, true);
assert.equal(result.parent.card, false);
assert.equal(result.parent.icon, true);
assert.ok(result.parent.arrowWidth > result.parent.cardWidth * 0.6, "返回箭头应接近卡片宽度");
assert.equal(result.parent.label, "返回上一级");
assert.equal(result.parent.title, "双击返回上一级");
assert.equal(result.afterSingle, "C:/Media/sub");
assert.equal(result.afterDouble, "C:/Media");
assert.equal(result.parentAfterDouble, false);
assert.equal(result.afterKeyboard, "C:/Media");
assert.equal(result.card.hasRow, true);
assert.equal(result.card.stem, "a-very-long-video-file-name-that-needs-truncation");
assert.equal(result.card.extension, "MP4");
assert.equal(result.card.oldMeta, false);
assert.equal(result.card.stemOverflow, "ellipsis");
assert.equal(result.card.stemTruncated, true);
assert.equal(result.card.extVisible, true);
assert.equal(result.card.extInsideCard, true);
assert.notEqual(result.card.extBackground, "rgba(0, 0, 0, 0)");
assert.ok(
  Math.abs(result.card.bodyHeight - result.folder.bodyHeight) < 1.5,
  `文件与文件夹名称区高度应一致: ${result.card.bodyHeight}px vs ${result.folder.bodyHeight}px`,
);
assert.equal(result.folder.hasRow, true);
assert.equal(result.folder.art, true, "文件夹应使用 Uiverse 3D 文件夹结构");
assert.equal(result.folder.sheets, 3, "3D 文件夹应包含三层纸张");
assert.equal(result.folder.back, true);
assert.equal(result.folder.front, true);
assert.equal(result.folder.oldIcon, false, "旧版单层 SVG 文件夹图标应移除");
assert.equal(result.folder.name, "deep");
assert.equal(result.folder.count, "1 项");
assert.equal(result.folder.sameLine, true);
assert.equal(result.folder.countRightAligned, true);
assert.ok(result.folder.bodyHeight < 36, `文件夹名称区应更紧凑: ${result.folder.bodyHeight}px`);
assert.equal(result.folder.nameOverflow, "ellipsis");
assert.equal(result.categoryInteraction.activeOnButton, true);
assert.equal(result.categoryInteraction.parentNotActive, true);
assert.equal(result.categoryInteraction.ariaPressed, "true");
assert.equal(result.categoryInteraction.activeCount, 1);

console.log("[PASS] 素材分类、返回箭头、文件卡与紧凑文件夹卡均符合预期");
