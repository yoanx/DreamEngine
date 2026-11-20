/* ============================================================
 * t09_cef_caps_probe.js —— CEP/CEF 能力与素材页布局实测探针
 *
 * 回答两个问题：
 *   1. 当前 CEP 的 Chromium 到底支持哪些现代 CSS 特性（逐个 CSS.supports 探测）
 *   2. 素材页卡片高度为什么会塌 —— 合成布局测量 + 真实 DOM 实测
 *
 * 不依赖 App / viewmodel，只依赖全局 Bridge（bridge.js）。
 * 结果用 Bridge.writeFile 直接写到 probe-results，不需要点「输出」页签。
 *
 * 用法（仅在已安装副本里临时注入，不随发布走）：
 *   <script src="js/t09_cef_caps_probe.js"></script>
 *   <script>setTimeout(function(){ T09.run("D:/.../T0_9_cef_caps.tsv"); }, 1500);</script>
 * ============================================================ */

var T09 = (function () {

  var lines = [];

  function row(key, value) {
    lines.push(key + "\t" + (value === undefined || value === null ? "" : String(value)));
  }

  function guard(name, fn) {
    try {
      fn();
    } catch (e) {
      row("ERR_" + name, e && e.toString ? e.toString() : String(e));
    }
  }

  function sup(prop, val) {
    try {
      if (!window.CSS || !CSS.supports) { return "no-CSS.supports"; }
      return CSS.supports(prop, val) ? "yes" : "no";
    } catch (e) {
      return "err";
    }
  }

  function px(n) {
    return Math.round(n * 100) / 100;
  }

  /* ---------- 1. 环境 ---------- */
  function probeEnv() {
    row("STAMP", new Date().toString());
    row("UA", navigator.userAgent);
    row("DPR", window.devicePixelRatio || 1);
    row("VIEWPORT", window.innerWidth + "x" + window.innerHeight);
    row("COMPAT_MODE", document.compatMode);

    var api = window.__adobe_cep__;
    if (api) {
      try {
        row("CEP_API", api.getCurrentApiVersion ? JSON.stringify(api.getCurrentApiVersion()) : "n/a");
      } catch (e) { row("CEP_API", "err"); }
      try {
        row("HOST_ENV", api.getHostEnvironment ? api.getHostEnvironment() : "n/a");
      } catch (e) { row("HOST_ENV", "err"); }
    } else {
      row("CEP_API", "no __adobe_cep__");
    }
  }

  /* ---------- 2. 特性矩阵 ---------- */
  function probeFeatures() {
    var m = [
      ["aspect-ratio", "aspect-ratio", "1 / 1"],
      ["inset", "inset", "0"],
      ["min()", "width", "min(10px, 50%)"],
      ["max()", "width", "max(10px, 5%)"],
      ["clamp()", "width", "clamp(10px, 5%, 40px)"],
      ["flex-gap", "gap", "8px"],              /* 只在 flex 容器生效，见 SYN_FLEXGAP */
      ["is()", "color", "rgb(0 0 0)"],         /* 占位，真正探测看 SELECTOR_IS */
      ["focus-visible", "outline", "1px solid"],
      ["position-sticky", "position", "sticky"],
      ["mask-image", "mask-image", "none"],
      ["webkit-mask-image", "-webkit-mask-image", "none"],
      ["background-clip-text", "background-clip", "text"],
      ["overscroll-behavior", "overscroll-behavior", "contain"],
      ["scrollbar-width", "scrollbar-width", "thin"],
      ["object-fit", "object-fit", "cover"],
      ["write-mode-lr", "writing-mode", "vertical-rl"],
      ["color-mix", "color", "color-mix(in srgb, #000, #fff)"],
      ["container-type", "container-type", "inline-size"],
      ["backdrop-filter", "backdrop-filter", "blur(2px)"],
      ["grid-gap", "gap", "8px"]
    ];
    for (var i = 0; i < m.length; i++) {
      row("CSS_" + m[i][0].toUpperCase().replace(/[^A-Z0-9]/g, "_"), sup(m[i][1], m[i][2]));
    }

    /* 选择器级支持：:is / :where / :has */
    var sel = [":is(a)", ":where(a)", ":has(a)"];
    for (var j = 0; j < sel.length; j++) {
      var ok;
      try {
        document.querySelector(sel[j]);
        ok = "yes";
      } catch (e2) {
        ok = "no";
      }
      row("SEL_" + sel[j].replace(/[^a-z]/g, "").toUpperCase(), ok);
    }
  }

  /* ---------- 3. 合成布局测量（关键：直接量出塌陷值） ---------- */
  function probeLayout() {
    var host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-9999px;top:0;width:200px;visibility:hidden;";
    document.body.appendChild(host);

    try {
      /* 3.1 素材卡片预览区：.material-preview { display:flex; aspect-ratio:16/10 } */
      var preview = document.createElement("div");
      preview.className = "material-preview";
      host.appendChild(preview);
      var pr = preview.getBoundingClientRect();
      row("SYN_PREVIEW_W200_H", px(pr.height));
      row("SYN_PREVIEW_W200_EXPECT", "125 if aspect-ratio works");

      /* 3.2 文件夹图形：父 62% 高度 + 5 个子块靠 inset 定位 */
      var art = document.createElement("div");
      art.className = "material-folder-art";
      var kids = [
        "material-folder-back",
        "material-folder-sheet material-folder-sheet-3",
        "material-folder-sheet material-folder-sheet-2",
        "material-folder-sheet material-folder-sheet-1",
        "material-folder-front"
      ];
      for (var k = 0; k < kids.length; k++) {
        var span = document.createElement("span");
        span.className = kids[k];
        art.appendChild(span);
      }
      preview.appendChild(art);
      row("SYN_ART_SIZE", px(art.getBoundingClientRect().width) + "x" + px(art.getBoundingClientRect().height));
      for (var n = 0; n < art.children.length; n++) {
        var c = art.children[n];
        row("SYN_ART_CHILD_" + n, c.className + "|" +
            px(c.getBoundingClientRect().width) + "x" + px(c.getBoundingClientRect().height));
      }

      /* 3.3 效果页缩略图：.thumb 同时有 padding-top 回退 */
      var thumb = document.createElement("div");
      thumb.className = "thumb";
      host.appendChild(thumb);
      row("SYN_THUMB_W200_H", px(thumb.getBoundingClientRect().height));
      row("SYN_THUMB_W200_EXPECT", "200 if padding-top fallback works");

      /* 3.4 返回上级箭头：真实结构 <button.material-parent><svg viewBox></svg></button>
         （上一版直接塞进普通 div，.material-parent svg 规则不命中，测的不是真场景） */
      var parentBtn = document.createElement("button");
      parentBtn.className = "material-parent";
      parentBtn.style.width = "200px";
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M12 2.5 2.5 12h6v9.5h7V12h6z");
      svg.appendChild(path);
      parentBtn.appendChild(svg);
      host.appendChild(parentBtn);
      var sr = svg.getBoundingClientRect();
      var pr2 = parentBtn.getBoundingClientRect();
      row("SYN_SVG_PARENT_SIZE", px(pr2.width) + "x" + px(pr2.height));
      row("SYN_SVG_SIZE", px(sr.width) + "x" + px(sr.height));
      row("SYN_SVG_EXPECT", "88x88 (square) / 88x150 (legacy replaced default height)");

      /* 3.5 inset:0 定位是否生效 */
      var rel = document.createElement("div");
      rel.style.cssText = "position:relative;width:100px;height:100px;";
      var abs = document.createElement("div");
      abs.style.cssText = "position:absolute;inset:0;";
      rel.appendChild(abs);
      host.appendChild(rel);
      row("SYN_INSET0_SIZE", px(abs.getBoundingClientRect().width) + "x" + px(abs.getBoundingClientRect().height));
      row("SYN_INSET0_EXPECT", "100x100 if inset works / 0x0 if ignored");

      /* 3.6 flex gap */
      var fg = document.createElement("div");
      fg.style.cssText = "display:flex;gap:8px;width:200px;";
      var f1 = document.createElement("div");
      f1.style.cssText = "width:20px;height:10px;";
      var f2 = document.createElement("div");
      f2.style.cssText = "width:20px;height:10px;";
      fg.appendChild(f1); fg.appendChild(f2);
      host.appendChild(fg);
      row("SYN_FLEXGAP_LEFT2", px(f2.getBoundingClientRect().left - f1.getBoundingClientRect().left));
      row("SYN_FLEXGAP_EXPECT", "28 if gap works / 20 if ignored");

      /* 3.7 min()/clamp() 实际取值 */
      var mw = document.createElement("div");
      mw.style.cssText = "width:min(50px, 100%);height:4px;";
      host.appendChild(mw);
      row("SYN_MIN_WIDTH", px(mw.getBoundingClientRect().width));

      var cw = document.createElement("div");
      cw.style.cssText = "width:clamp(60px, 10%, 40px);height:4px;";
      host.appendChild(cw);
      row("SYN_CLAMP_WIDTH", px(cw.getBoundingClientRect().width));

      /* 3.8 网格：auto-fill + minmax(min()) */
      var g = document.createElement("div");
      g.style.cssText = "display:grid;width:200px;" +
        "grid-template-columns:repeat(auto-fill, minmax(min(80px, 100%), 80px));gap:8px;";
      for (var q = 0; q < 4; q++) { g.appendChild(document.createElement("div")); }
      host.appendChild(g);
      var gcs = window.getComputedStyle(g);
      row("SYN_GRID_COLS", gcs.getPropertyValue("grid-template-columns") || gcs.gridTemplateColumns || "-");
      row("SYN_GRID_FIRST_CHILD_W", px(g.children[0].getBoundingClientRect().width));
    } finally {
      if (host.parentNode) { host.parentNode.removeChild(host); }
    }
  }

  /* ---------- 4. 真实 DOM 实测（素材页当前渲染结果） ---------- */
  function probeLive() {
    var cards = document.querySelectorAll(".material-card");
    row("LIVE_CARD_COUNT", cards.length);

    var limit = Math.min(cards.length, 16);
    for (var i = 0; i < limit; i++) {
      var card = cards[i];
      var prev = card.querySelector(".material-preview");
      var art = card.querySelector(".material-folder-art");
      var info = "class=" + card.className +
        "|card=" + px(card.getBoundingClientRect().width) + "x" + px(card.getBoundingClientRect().height);
      if (prev) {
        var pcs = window.getComputedStyle(prev);
        info += "|preview=" + px(prev.getBoundingClientRect().height);
        info += "|ar=" + (pcs.getPropertyValue("aspect-ratio") || "-");
        info += "|prevH=" + pcs.getPropertyValue("height");
        info += "|kid=" + (prev.firstElementChild ? prev.firstElementChild.className : "none");
      }
      if (art) {
        info += "|art=" + px(art.getBoundingClientRect().width) + "x" + px(art.getBoundingClientRect().height);
      }
      row("LIVE_CARD_" + i, info);
    }

    var grid = document.querySelector(".grid");
    if (grid) {
      var gcs = window.getComputedStyle(grid);
      row("LIVE_GRID", "cols=" + (gcs.getPropertyValue("grid-template-columns") || "-") +
          "|gap=" + (gcs.getPropertyValue("gap") || "-"));
      var gb = grid.getBoundingClientRect();
      row("LIVE_GRID_BOX", px(gb.width) + "x" + px(gb.height));
    } else {
      row("LIVE_GRID", "no .grid in DOM");
    }

    var root = document.documentElement;
    row("LIVE_ROOT_VARS", "view-size=" + (window.getComputedStyle(root).getPropertyValue("--view-size") || "(unset)"));
    row("LIVE_VIEW_TAB", (function () {
      var active = document.querySelector(".viewtab.active, .tab.active, [data-view].active");
      return active ? active.className : "(unknown)";
    })());
  }

  /* ---------- 入口 ---------- */
  function write(outPath, text) {
    if (window.Bridge && window.Bridge.writeFile && outPath) {
      window.Bridge.writeFile(outPath, text, function (res) {
        if (window.console) { console.log("[T09] write " + res); }
        if (res && res.indexOf("OK") !== 0) {
          try { window.localStorage.setItem("T09_RESULT", text); } catch (e) {}
        }
      });
    } else {
      try { window.localStorage.setItem("T09_RESULT", text); } catch (e) {}
      if (window.console) { console.log(text); }
    }
  }

  /** 静态部分：环境 + 特性矩阵 + 合成布局（不依赖当前在哪个页签） */
  function run(outPath) {
    lines = [];
    guard("env", probeEnv);
    guard("features", probeFeatures);
    guard("layout", probeLayout);
    var text = "PROBE=T0_9_CEF_CAPS\r\n" + lines.join("\r\n") + "\r\n";
    write(outPath, text);
    return text;
  }

  /** 动态部分：等素材卡片渲染出来再量真实尺寸。
   *  用户切到「素材」页才有 .material-card，因此用轮询而不是定时写死。 */
  function watchLive(outPath, timeoutMs) {
    var started = Date.now();
    var limit = timeoutMs || 60000;
    var timer = window.setInterval(function () {
      var cards = document.querySelectorAll(".material-card");
      if (cards.length > 0) {
        window.clearInterval(timer);
        /* 再等一帧多，让图片/波形完成首轮回流 */
        window.setTimeout(function () {
          lines = [];
          guard("live", probeLive);
          var text = "PROBE=T0_9B_LIVE\r\n" + lines.join("\r\n") + "\r\n";
          write(outPath, text);
        }, 700);
        return;
      }
      if (Date.now() - started > limit) { window.clearInterval(timer); }
    }, 400);
  }

  return { run: run, watchLive: watchLive };
})();
