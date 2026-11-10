#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PANEL = resolve(ROOT, "cep/com.dreamengine.panel");
const SIM = resolve(PANEL, "__sim_materials.html");

function findChrome() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ];
  return candidates.find((path) => existsSync(path)) || "";
}

const browser = findChrome();
if (!browser) {
  console.log("skip: Chrome/Edge not found");
  process.exit(0);
}

const index = {
  version: 1,
  root: "C:/Media",
  scannedAt: "2026-11-05T12:00:00",
  count: 4,
  items: [
    {
      path: "C:/Media/a.mp4",
      name: "%E7%BB%AD%E6%A2%A6.mp4",
      type: "video",
      extension: ".mp4",
      size: 10,
      modifiedAt: 1,
      exists: true,
      videoPreview: "C:/docs/materials/video-previews/a.mp4",
    },
    { path: "C:/Media/b.png", name: "b.png", type: "image", extension: ".png", size: 10, modifiedAt: 1, exists: true },
    {
      path: "C:/Media/c.wav",
      name: "c.wav",
      type: "audio",
      extension: ".wav",
      size: 10,
      modifiedAt: 1,
      exists: true,
    },
    { path: "C:/Media/d.aep", name: "d.aep", type: "project", extension: ".aep", size: 10, modifiedAt: 1, exists: true },
    {
      path: "C:/Media/deleted.mp4",
      name: "deleted.mp4",
      type: "video",
      extension: ".mp4",
      size: 10,
      modifiedAt: 1,
      exists: false,
    },
  ],
};

const stub = `
<style>
/* headless --virtual-time-budget 不推进过渡动画，量选中态前必须先关掉过渡 */
*, *::before, *::after { transition: none !important; animation: none !important; }
</style>
<script>
window.__SIM_ERRORS = [];
try {
  localStorage.setItem("dreamengine.uiLayout.v1", JSON.stringify({
    thumbSizes: { materials: 88 }
  }));
} catch (e0) {}
window.addEventListener("error", function (event) { window.__SIM_ERRORS.push(String(event.message)); });
(function () {
  var materials = ${JSON.stringify(JSON.stringify(index))};
  window.__SIM_IMPORTS = [];
  HTMLMediaElement.prototype.play = function () {
    this.__paused = false;
    return { catch: function () {} };
  };
  HTMLMediaElement.prototype.pause = function () {
    this.__paused = true;
  };
  Bridge.getExtensionPath = function (cb) { cb(${JSON.stringify(PANEL.replace(/\\/g, "/"))}); };
  Bridge.evalAE = function (_jsx, cb) { if (cb) cb("OK"); };
  Bridge.watchStamp = function (_path, cb) { cb("stamp"); };
  Bridge.runEngine = function (_path, expr, cb) {
    var out = '{"status":"ok"}';
    if (expr.indexOf("AEV_Materials.indexJson") === 0) out = materials;
    else if (expr.indexOf("AEV_Materials.importJson") === 0) {
      window.__SIM_IMPORTS.push(expr);
      out = '{"status":"ok"}';
    }
    else if (expr.indexOf("AEV_Catalog.getCatalogJson") === 0) out = '{"version":1,"count":0,"effects":[]}';
    else if (expr.indexOf("AEV_PreviewGen.staleList") === 0) out = '{"stale":[]}';
    else if (expr.indexOf("AEV_Queue.stats") === 0) out = '{"total":0,"pending":0,"rendering":0,"cached":0,"failed":0}';
    else if (expr.indexOf("AEV_Queue.listJson") === 0) out = '{"total":0,"items":[]}';
    else if (expr.indexOf("AEV_PresetPreview.backgroundsJson") === 0) out = '{"status":"ok","items":[]}';
    else if (expr.indexOf("AEV_Presets.libraryJson") === 0) out = '{"status":"ok","count":0,"items":[]}';
    if (cb) setTimeout(function () { cb(out); }, 0);
  };
  AEV_AudioWaveform.load = function (_path, _columns, cb) {
    setTimeout(function () {
      cb(null, [0.1, 0.35, 0.8, 0.45, 1, 0.25, 0.6, 0.2]);
    }, 0);
  };
})();
</script>`;

const probe = `
<pre id="out"></pre>
<script>
function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
async function done() {
  try {
    document.getElementById("tabMaterials").click();
    await wait(500);
    var materialInitialSlider = document.getElementById("thumbSize").value;
    var materialInitialSize = String(document.documentElement.style.getPropertyValue("--view-size"));
    var initialCards = document.querySelectorAll("#materialGrid .material-card").length;
    var videoCard = document.querySelector(".material-card.video");
    var missingCards = document.querySelectorAll(".material-card.missing").length;
    var missingText = document.getElementById("materialGrid").textContent.indexOf("文件缺失") >= 0;
    var video = videoCard.querySelector("video");
    video.__paused = true;
    videoCard.dispatchEvent(new MouseEvent("mouseenter"));
    await wait(150);
    var hoverDidNotPlay = video.__paused === true;

    videoCard.click();
    await wait(700);   // 单击有防抖（区分双击）+ 选中态有 0.12s 过渡，等它稳定
    var videoSelected = videoCard.classList.contains("selected");
    var videoPlaying = video.__paused === false;
    var selectedStyle = window.getComputedStyle(videoCard);
    var selectedBorder = selectedStyle.borderColor;
    var selectedRadius = selectedStyle.borderRadius;
    var selectedRing = window.getComputedStyle(videoCard, "::after");
    var selectedRingContent = selectedRing.content;
    var selectedRingBorder = selectedRing.borderTopColor;
    var selectedRingWidth = selectedRing.borderTopWidth;
    var selectedRingRadius = selectedRing.borderTopLeftRadius;
    var selectedRingZ = selectedRing.zIndex;
    var baseRingOpacity = window.getComputedStyle(videoCard, "::before").opacity;
    var hoverRingOpacity = "";
    function findCssValue(selectorPart, property) {
      function visit(rules) {
        for (var r = 0; r < rules.length; r++) {
          var rule = rules[r];
          if (rule.selectorText && rule.selectorText.indexOf(selectorPart) >= 0) {
            var value = rule.style && rule.style.getPropertyValue(property);
            if (value) return value;
          }
          if (rule.cssRules) {
            var nested = visit(rule.cssRules);
            if (nested) return nested;
          }
        }
        return "";
      }
      for (var s = 0; s < document.styleSheets.length; s++) {
        try {
          var found = visit(document.styleSheets[s].cssRules);
          if (found) return found;
        } catch (eCss) {}
      }
      return "";
    }
    hoverRingOpacity = findCssValue(".material-card:hover::before", "opacity");


    var audioCard = document.querySelector(".material-card.audio");
    var audio = audioCard.querySelector("audio");
    var waveform = audioCard.querySelector(".material-waveform");
    var waveformCanvas = waveform && waveform.querySelector("canvas");
    var waveformReady = !!(waveform && waveform.classList.contains("is-ready"));
    var waveformPainted = 0;
    if (waveformCanvas) {
      var waveformData = waveformCanvas.getContext("2d")
        .getImageData(0, 0, waveformCanvas.width, waveformCanvas.height).data;
      for (var wp = 3; wp < waveformData.length; wp += 4) {
        if (waveformData[wp] > 8) waveformPainted++;
      }
    }
    audio.__paused = true;
    audioCard.click();
    await wait(520);
    var audioPlaying = audio.__paused === false;
    var audioVolumeAfterPlay = Number(audio.volume);
    audioCard.click();
    await wait(500);
    var audioStopped = audio.__paused === true;
    var audioVolumeAfterStop = Number(audio.volume);

    var projectCard = document.querySelector(".material-card.project");
    var importsBefore = window.__SIM_IMPORTS.length;
    projectCard.dispatchEvent(new MouseEvent("dblclick"));
    var projectImportCount = window.__SIM_IMPORTS.length - importsBefore;
    var importsBeforeVideo = window.__SIM_IMPORTS.length;
    videoCard.dispatchEvent(new MouseEvent("dblclick"));
    var videoImports = window.__SIM_IMPORTS.length - importsBeforeVideo;

    var imageCard = document.querySelector(".material-card.image");
    var favorite = imageCard.querySelector(".favorite-toggle");
    favorite.click();
    var favoriteStored = false;
    try {
      favoriteStored = String(localStorage.getItem("dreamengine.favorites.v1") || "")
        .indexOf("c:/media/b.png") >= 0;
    } catch (eFav) {}
    var favoriteFilter = document.querySelector('#materialCategories [data-category-id="__favorites__"]');
    var favoriteFirst = !!favoriteFilter &&
      document.getElementById("materialCategories").firstElementChild.contains(favoriteFilter);
    if (favoriteFilter) favoriteFilter.click();
    await wait(100);
    var favoriteCards = document.querySelectorAll("#materialGrid .material-card").length;
    var imageCategory = document.querySelector('#materialCategories [data-category-id="image"]');
    var videoCategory = document.querySelector('#materialCategories [data-category-id="video"]');
    imageCategory.click();
    await wait(100);
    var favoriteImageCount = document.querySelectorAll("#materialGrid .material-card").length;
    var activeImageCategory = document.querySelector('#materialCategories [data-category-id="image"]');
    var activeFavoriteFilter = document.querySelector('#materialCategories [data-category-id="__favorites__"]');
    var combinedActive = activeFavoriteFilter.classList.contains("active") &&
      activeImageCategory.classList.contains("active");
    videoCategory.click();
    await wait(100);
    var favoriteVideoCount = document.querySelectorAll("#materialGrid .material-card").length;

    var sizeSlider = document.getElementById("thumbSize");
    sizeSlider.value = "96";
    var sizeEvent = document.createEvent("HTMLEvents");
    sizeEvent.initEvent("input", true, false);
    sizeSlider.dispatchEvent(sizeEvent);
    var materialSize = String(document.documentElement.style.getPropertyValue("--view-size"));
    var materialSliderValue = sizeSlider.value;
    document.getElementById("tabEffects").click();
    document.getElementById("tabMaterials").click();
    await wait(100);
    var materialSliderRestored = sizeSlider.value;
    var materialSizeRestored = String(document.documentElement.style.getPropertyValue("--view-size"));
    var savedThumbSizes = null;
    try {
      savedThumbSizes = JSON.parse(localStorage.getItem("dreamengine.uiLayout.v1")).thumbSizes;
    } catch (eSaved) {}

    var result = {
      errors: window.__SIM_ERRORS,
      tabs: document.querySelectorAll(".view-tab").length,
      viewHidden: document.getElementById("viewMaterials").hidden,
      cards: initialCards,
      missingCards: missingCards,
      missingText: missingText,
      categories: document.querySelectorAll(".material-category").length,
      // 素材页顶部已从「共 N 个素材」换成面包屑，摘要改拓面包屑文本
      breadcrumb: String((document.getElementById("materialBreadcrumb") || {}).textContent || ""),
      folderCards: document.querySelectorAll(".material-folder").length,
      hoverDidNotPlay: hoverDidNotPlay,
      videoSelected: videoSelected,
      videoPlaying: videoPlaying,
      videoName: videoCard.querySelector(".material-file-stem").textContent + "." +
        videoCard.querySelector(".material-file-ext").textContent.toLowerCase(),
      selectedBorder: selectedBorder,
      selectedRingContent: selectedRingContent,
      selectedRingBorder: selectedRingBorder,
      selectedRingWidth: selectedRingWidth,
      selectedRingRadius: selectedRingRadius,
      selectedRingZ: selectedRingZ,
      selectedRadius: selectedRadius,
      baseRingOpacity: baseRingOpacity,
      hoverRingOpacity: hoverRingOpacity,
      videoSrc: video.src,
      audioPlaying: audioPlaying,
      audioStopped: audioStopped,
      audioVolumeAfterPlay: audioVolumeAfterPlay,
      audioVolumeAfterStop: audioVolumeAfterStop,
      waveformReady: waveformReady,
      waveformPainted: waveformPainted,
      projectMedia: projectCard.querySelector("video,audio,img") ? 1 : 0,
      projectImportCount: projectImportCount,
      videoImports: videoImports,
      favoriteStored: favoriteStored,
      favoriteCards: favoriteCards,
      favoriteFilterExists: !!favoriteFilter,
      favoriteFirst: favoriteFirst,
      favoriteImageCount: favoriteImageCount,
      favoriteVideoCount: favoriteVideoCount,
      combinedActive: combinedActive,
      materialInitialSlider: materialInitialSlider,
      materialInitialSize: materialInitialSize,
      materialSize: materialSize,
      materialSliderValue: materialSliderValue,
      materialSliderRestored: materialSliderRestored,
      materialSizeRestored: materialSizeRestored,
      savedThumbSizes: savedThumbSizes
    };
    document.getElementById("out").textContent = JSON.stringify(result);
  } catch (error) {
    document.getElementById("out").textContent = JSON.stringify({ fatal: String(error) });
  }
}
setTimeout(done, 2000);
</script>`;

const html = readFileSync(resolve(PANEL, "index.html"), "utf8")
  .replace("</body>", `${stub}${probe}</body>`);
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
      "--virtual-time-budget=9000",
      "file:///" + SIM.replace(/\\/g, "/"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
  );
} finally {
  try { unlinkSync(SIM); } catch {}
}

const block = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
assert.ok(block, "materials UI did not write a result");
const result = JSON.parse(block[1].replace(/&quot;/g, '"'));
assert.equal(result.fatal, undefined, result.fatal);
assert.deepEqual(result.errors, []);
assert.equal(result.tabs, 4);
assert.equal(result.viewHidden, false);
assert.equal(result.cards, 4);
assert.equal(result.missingCards, 0, "已删除素材不应生成缺失卡片");
assert.equal(result.missingText, false, "素材列表里不应再出现「文件缺失」");
assert.equal(result.categories, 7);
assert.match(result.breadcrumb, /\S/, "面包屑应该有内容（至少根目录名）");
assert.equal(result.hoverDidNotPlay, true, "素材不应再在悬停时播放");
assert.equal(result.videoSelected, true, "单击素材后应选中卡片");
assert.equal(result.videoPlaying, true, "单击视频后应开始播放");
assert.equal(result.videoName, "续梦.mp4", "素材卡片名称应解码 ExtendScript 返回的 URL 编码");
assert.doesNotMatch(result.selectedBorder, /rgba?\(255,\s*255,\s*255(?:,\s*0\.9)?\)/,
  "选中素材不应常驻白色边框");
assert.equal(result.selectedRingContent, "none", "选中素材不应再绘制常驻白框伪元素");
assert.equal(result.selectedRingWidth, "0px", "选中素材不应再绘制常驻白框");
assert.equal(result.baseRingOpacity, "0", "素材卡片默认状态不应显示白框");
assert.equal(result.hoverRingOpacity, "0.95", "素材卡片悬停时应显示白框");
assert.match(result.videoSrc, /^file:\/\/\/C:\/docs\/materials\/video-previews\//);
assert.equal(result.audioPlaying, true);
assert.equal(result.audioStopped, true);
assert.ok(Math.abs(result.audioVolumeAfterPlay - 0.35) < 0.001, "音频预览应降到 35% 音量");
assert.equal(result.audioVolumeAfterStop, 0, "音频预览停止后音量应归零");
assert.equal(result.waveformReady, true, "音频卡片没有生成 Canvas 波形");
assert.ok(result.waveformPainted > 50, "音频波形 Canvas 没有实际绘制内容");
assert.equal(result.projectMedia, 0);
assert.equal(result.projectImportCount, 1, ".aep 双击应导入项目");
assert.equal(result.videoImports, 1);
assert.equal(result.favoriteFilterExists, true, "分类栏顶部缺少收藏筛选");
assert.equal(result.favoriteFirst, true, "素材收藏筛选应位于分类栏最上方");
assert.equal(result.favoriteStored, true, "点击星标后收藏没有持久化");
assert.equal(result.favoriteCards, 1, "收藏筛选应只显示已收藏素材");
assert.equal(result.favoriteImageCount, 1, "收藏与图片分类应能组合筛选");
assert.equal(result.favoriteVideoCount, 0, "收藏与视频分类组合后不应显示未收藏视频");
assert.equal(result.combinedActive, true, "收藏与分类筛选应能同时处于激活状态");
assert.equal(result.materialInitialSlider, "88", "重开面板后没有恢复素材卡片尺寸");
assert.equal(result.materialInitialSize, "88px");
assert.equal(result.materialSize, "96px");
assert.equal(result.materialSliderValue, "96");
assert.equal(result.materialSliderRestored, "96");
assert.equal(result.materialSizeRestored, "96px");
assert.equal(result.savedThumbSizes.materials, 96, "素材卡片尺寸没有持久化");
console.log("[PASS] materials view shell and category cards");
