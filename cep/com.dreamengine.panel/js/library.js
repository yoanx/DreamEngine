var AEV_Library = (function () {
  var state = {
    lang: "zh",
    query: "",
    plugin: "内置",
    showAll: true,
    names: {},
    previews: {},
    previewVariants: {},
    effectBackground: "",
    manifest: null,
    catalog: [],
    items: [],
    extensionPath: "",
    // 有图但配方/素材已变、需要重渲的条目（来自 AEV_PreviewGen.staleList）
    stale: {},
    // 插件 L2 预览：被拉黑的效果与已生成数量（独立索引，不进 entries）
    pluginBlacklist: {},
    pluginPreviewCount: 0,
    // 各来源（内置 / BCC / Sapphire…）已有多少张预览
    pluginCounts: {},
    // 预设库（M3）：用户自建库里的 .ffx 和 Hub 生成的预览索引
    presets: [],
    presetFolder: "",
    presetQuery: "",
    presetPreviews: {},
    presetCategory: "all",
    presetFavoritesOnly: false,
    presetOrganizer: { categories: [], assignments: {}, favorites: {} },
    presetEditorMode: "create",
    presetEditingId: "",
    presetHoldTimer: null,
    presetHoldTriggeredPath: "",
    deletePresetPath: "",
    deletePresetName: "",
    // 排序方式：name = 按名称首字母，category = 按 AE 分类
    sortMode: "name",
    // 左侧栏选中的分类键（空 = 全部）
    category: "",
    effectFavoritesOnly: false,
    // AE 菜单里的分类顺序（从 catalog 首次出现顺序推导）
    categoryOrder: [],
    // 效果 / 预设 / 素材各自保存方块尺寸（px）
    thumbSizes: { effects: 132, presets: 180, materials: 132 },
    // 当前主视图：effects = 效果预览，presets = 预设预览，curve = 曲线编辑
    view: "effects",
    // 已知「帧内容完全相同」的预览：这些是静态效果，不该轮播（会闪）
    staticPreviews: {}
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function isFavorite(kind, id) {
    if (kind === "presets") {
      return !!(
        window.AEV_Prefs &&
        state.presetOrganizer.favorites &&
        state.presetOrganizer.favorites[AEV_Prefs.pathKey(id)]
      );
    }
    return window.AEV_Prefs && AEV_Prefs.isFavorite(kind, id);
  }

  function appendStarIcon(button) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"
    );
    svg.appendChild(path);
    button.appendChild(svg);
  }

  function favoriteButton(kind, id, onChange) {
    var active = isFavorite(kind, id);
    var button = document.createElement("button");
    button.type = "button";
    button.className = "favorite-toggle" + (active ? " active" : "");
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.setAttribute("aria-label", L(active ? "favorites.remove" : "favorites.add"));
    button.title = L(active ? "favorites.remove" : "favorites.add");
    appendStarIcon(button);
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      if (kind === "presets") {
        engine(
          "AEV_PresetCategories.toggleFavoriteJson(" + JSON.stringify(id) + ")",
          function (result) {
            updatePresetOrganizer(parseEngineResult(result));
            if (onChange) onChange();
          }
        );
        return;
      }
      AEV_Prefs.toggleFavorite(kind, id);
      if (onChange) onChange();
    });
    button.addEventListener("dblclick", function (event) {
      event.stopPropagation();
    });
    return button;
  }

  function loadJson(path, callback) {
    var request = new XMLHttpRequest();
    request.open("GET", path, true);
    request.onreadystatechange = function () {
      if (request.readyState !== 4) return;
      if ((request.status === 200 || request.status === 0) && request.responseText) {
        try {
          callback(null, JSON.parse(request.responseText));
        } catch (error) {
          callback(error);
        }
      } else {
        callback(new Error(L("msg.readFail", [path])));
      }
    };
    request.send();
  }

  /** 可选索引：插件 L2 索引/黑名单在首次安装时根本不存在，不能中断 refresh */
  function loadOptionalJson(path, callback) {
    loadJson(path, function (error, data) {
      callback(error ? null : data);
    });
  }

  /**
   * 取本机效果清单。
   * 走 runEngine 而不是单独 evalFile：单独 eval 会把 catalog 模块整个重置，
   * 模块里的会话缓存（枚举 1371 条的结果）就白丢了。
   * force=true 表示「重新扫描」——用户装了新插件后要能看到。
   */
  function getCatalog(callback, force) {
    Bridge.getExtensionPath(function (extensionPath) {
      if (!extensionPath) {
        callback(new Error(L("msg.noExtDir")));
        return;
      }
      state.extensionPath = extensionPath;
      Bridge.runEngine(
        extensionPath,
        "AEV_Catalog.getCatalogJson(" + (force ? "true" : "false") + ")",
        function (result) {
          if (!result || result.indexOf("ERR:") === 0) {
            callback(new Error(result || L("msg.emptyCatalog")));
            return;
          }
          try {
            callback(null, JSON.parse(result));
          } catch (error) {
            callback(error);
          }
        }
      );
    });
  }

  // 排除规则统一放在 viewmodel，面板与离线清单生成共用同一份判断
  function isActiveEffect(effect) {
    return !AEV_ViewModel.isExcludable(effect);
  }

  function addPreviewVariant(preview) {
    if (!preview || !preview.matchName) return;
    var key = preview.matchName;
    if (!state.previewVariants[key]) state.previewVariants[key] = [];
    state.previewVariants[key].push(preview);
  }

  function selectPreviews() {
    state.previews = {};
    for (var matchName in state.previewVariants) {
      if (!state.previewVariants.hasOwnProperty(matchName)) continue;
      var preview = AEV_ViewModel.choosePreview(state.previewVariants[matchName]);
      if (preview) state.previews[matchName] = preview;
    }
  }

  function rebuildItems() {
    var installed = {};
    var i;
    for (i = 0; i < state.catalog.length; i++) {
      installed[state.catalog[i].matchName] = state.catalog[i];
    }

    var items = [];
    if (state.showAll) {
      for (i = 0; i < state.catalog.length; i++) {
        if (isActiveEffect(state.catalog[i])) {
          items.push(
            AEV_ViewModel.buildItem(state.catalog[i], state.names, state.previews, state.stale)
          );
        }
      }
    } else {
      var previewKeys = Object.keys(state.previews);
      for (i = 0; i < previewKeys.length; i++) {
        var matchName = previewKeys[i];
        var effect = installed[matchName];
        if (!effect) {
          var nameRecord = state.names[matchName] || {};
          effect = {
            matchName: matchName,
            displayName: nameRecord.nameEn || matchName,
            category: ""
          };
        }
        var item = AEV_ViewModel.buildItem(effect, state.names, state.previews, state.stale);
        item.installed = !!installed[matchName];
        items.push(item);
      }
    }
    var counts = {};
    for (i = 0; i < items.length; i++) {
      if (!items[i].hasPreview) continue;
      counts[items[i].plugin] = (counts[items[i].plugin] || 0) + 1;
    }
    state.pluginCounts = counts;
    state.items = items;
    updatePluginCounts();
  }

  /**
   * 来源下拉里标出每个插件包已有多少张预览。
   * 插件预览是逐条离线渲出来的，用户得一眼看到「哪个包已经有图」，
   * 否则切到 BCC 只看到一片「待离线生成」还以为功能坏了。
   */
  function updatePluginCounts() {
    var select = byId("pluginFilter");
    if (!select) return;
    var options = select.getElementsByTagName("option");
    for (var i = 0; i < options.length; i++) {
      var option = options[i];
      var base = option.getAttribute("data-label");
      if (!base) {
        base = option.textContent;
        option.setAttribute("data-label", base);
      }
      if (option.value === "全部") {
        option.textContent = base;
        continue;
      }
      var n = state.pluginCounts[option.value] || 0;
      option.textContent = n > 0 ? base + " · " + n : base;
    }
  }

  /**
   * 给缩略框挂预览 —— 效果卡与预设卡共用同一套逻辑。
   *
   * 两个实机踩过的点都在这里：
   *   · 帧没预加载完就切 background-image，浏览器会先撤掉旧背景 →「闪几下」
   *   · 各帧内容相同的静态预览不该轮播，否则只会反复重解码同一张图
   *
   * stillIndex：静止时显示第几帧，默认中间帧。
   */
  function attachPreview(thumb, card, preview, isAnimated, stillIndex) {
    var slice = AEV_ViewModel.spriteSlice(preview, state.manifest);
    thumb.style.backgroundSize = slice.size;
    thumb.style.backgroundPosition = slice.position;
    if (preview.webpSrc) {
      thumb.style.backgroundSize = "cover";
      thumb.style.backgroundPosition = "center";
      thumb.style.backgroundImage =
        'url("data/' + (preview.stillSrc || preview.webpSrc) + '")';
      var animated = document.createElement("img");
      animated.className = "preview-webp";
      animated.alt = "";
      thumb.appendChild(animated);
      var webpTimer = null;
      var stopWebp = function () {
        if (webpTimer) {
          clearTimeout(webpTimer);
          webpTimer = null;
        }
        animated.classList.remove("playing");
        if (animated.getAttribute("src")) animated.removeAttribute("src");
        for (var s = 0; s < activePreviewStops.length; s++) {
          if (activePreviewStops[s] === stopWebp) {
            activePreviewStops.splice(s, 1);
            break;
          }
        }
      };
      if (isAnimated && Number(preview.frames) > 1) {
        card.addEventListener("mouseenter", function () {
          if (Date.now() < previewSuppressUntil) return;
          if (webpTimer) clearTimeout(webpTimer);
          webpTimer = setTimeout(function () {
            webpTimer = null;
            animated.onload = function () {
              animated.classList.add("playing");
            };
            animated.src = "data/" + preview.webpSrc;
            if (activePreviewStops.indexOf(stopWebp) < 0) activePreviewStops.push(stopWebp);
          }, 220);
        });
        card.addEventListener("mouseleave", stopWebp);
      }
      return;
    }
    if (!preview.frameSrc) {
      thumb.style.backgroundImage = 'url("data/' + preview.src + '")';
      return;
    }
    var frameCount = preview.frames || 1;
    var durationSeconds = Number(preview.duration) || 0;
    var sourceFps = Number(preview.fps) || 0;
    var frameDelay = durationSeconds > 0
      ? (durationSeconds * 1000) / frameCount
      : (sourceFps > 0 ? 1000 / sourceFps : 83);
    frameDelay = Math.max(16, Math.round(frameDelay));
    var frameIndex = 0;
    var playTimer = null;
    var hoverTimer = null;
    var showFrame = function (index) {
      thumb.style.backgroundImage =
        'url("' + framePath(preview.frameSrc, index) + '")';
    };
    var stop = function () {
      if (!playTimer) return;
      clearInterval(playTimer);
      playTimer = null;
      for (var i = 0; i < activePreviewStops.length; i++) {
        if (activePreviewStops[i] === stop) {
          activePreviewStops.splice(i, 1);
          break;
        }
      }
    };
    var startPlaying = function () {
      if (playTimer || Date.now() < previewSuppressUntil) return;
      frameIndex = 0;
      showFrame(frameIndex);
      playTimer = setInterval(function () {
        frameIndex = (frameIndex + 1) % frameCount;
        showFrame(frameIndex);
      }, frameDelay);
      activePreviewStops.push(stop);
    };
    var play = function () {
      if (!isAnimated || playTimer || frameCount < 2 || Date.now() < previewSuppressUntil) return;
      if (preview.__ready) {
        startPlaying();
        return;
      }
      var urls = [];
      for (var f = 0; f < frameCount; f++) urls.push(framePath(preview.frameSrc, f));
      preloadFrames(urls, function () {
        preview.__ready = true;
        if (card.matches(":hover")) startPlaying();
      });
    };
    var still = stillIndex === undefined ? Math.floor(frameCount / 2) : stillIndex;
    if (still < 0) still = 0;
    if (still > frameCount - 1) still = frameCount - 1;
    showFrame(still);
    if (isAnimated && frameCount > 1) {
      card.addEventListener("mouseenter", function () {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = setTimeout(function () {
          hoverTimer = null;
          play();
        }, 220);
      });
      card.addEventListener("mouseleave", function () {
        if (hoverTimer) {
          clearTimeout(hoverTimer);
          hoverTimer = null;
        }
        stop();
      });
    }
  }

  /** 插件名：数据层是中文 key，显示时按语言换 */
  function pluginLabel(plugin) {
    if (plugin === "内置") return L("filter.builtin");
    if (plugin === "其它插件") return L("filter.other");
    return plugin;
  }

  function createCard(item) {
    var card = document.createElement("div");
    card.className = "effect-card" + (item.stale ? " stale" : "");
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", AEV_ViewModel.resolveName(item, state.lang));

    var thumb = document.createElement("div");
    thumb.className = "thumb";
    if (item.hasPreview) {
      var preview = item.preview;
      var previewCurrent =
        Number(preview.effectPreviewVersion) === 2 &&
        Number(preview.frames) === 24 &&
        Number(preview.fps) === 24;
      var isAnimated =
        previewCurrent &&
        state.staticPreviews[item.matchName] !== true &&
        (!preview.frameSrc || (preview.frames || 1) > 1);
      var stillIndex = undefined;
      attachPreview(thumb, card, preview, isAnimated, stillIndex);
    } else {
      var placeholder = document.createElement("span");
      placeholder.className = "thumb-placeholder";
      var skipReason = state.pluginBlacklist[item.matchName];
      if (skipReason) {
        placeholder.textContent = state.lang === "zh" ? "已跳过" : "Skipped";
        card.title = (state.lang === "zh" ? "已跳过：" : "skipped: ") + skipReason;
      } else if (item.plugin !== "内置") {
        placeholder.textContent = state.lang === "zh" ? "待离线生成" : "Offline render";
      } else {
        placeholder.textContent = state.lang === "zh" ? "无预览" : "No preview";
      }
      thumb.appendChild(placeholder);
    }
    thumb.appendChild(favoriteButton("effects", item.matchName, render));

    /* hover 时浮出的「加到选中层」入口。
       双击仍是主路径；+ 只是给鼠标用户一个可见的替代。 */
    var addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "card-plus";
    addButton.textContent = "+";
    addButton.title = L("card.addButton");
    addButton.setAttribute("aria-label", L("card.addButton"));
    addButton.addEventListener("click", function (event) {
      event.stopPropagation();
      applyToSelectedLayer(item);
    });
    addButton.addEventListener("dblclick", function (event) {
      event.stopPropagation();
    });
    thumb.appendChild(addButton);

    var copy = document.createElement("div");
    copy.className = "card-copy";

    var name = document.createElement("span");
    name.className = "card-name";
    name.textContent = AEV_ViewModel.resolveName(item, state.lang);

    var meta = document.createElement("span");
    meta.className = "card-meta";
    var dot = document.createElement("span");
    dot.className = "plugin-dot" + (item.installed === false ? " missing" : "");
    var category = document.createElement("span");
    category.className = "card-category";
    var categoryText = AEV_ViewModel.resolveCategory(item, state.lang);
    if (item.installed === false) {
      categoryText = state.lang === "zh" ? "当前机器未安装" : "Not installed";
    }
    /* item.plugin 是数据层的 key（"内置" / "其它插件"），过滤逻辑依赖它，
       所以不能改数据；只在显示时换成当前语言。 */
    category.textContent =
      categoryText.indexOf(item.plugin) === 0
        ? categoryText
        : pluginLabel(item.plugin) + " · " + categoryText;

    meta.appendChild(dot);
    meta.appendChild(category);
    copy.appendChild(name);
    copy.appendChild(meta);
    card.appendChild(thumb);
    card.appendChild(copy);
    // 双击 = 把这个效果加到 AE 当前选中的图层。
    // 单击不做任何事：效果墙是浏览用的，误加效果会污染用户的工程。
    card.addEventListener("dblclick", function () {
      applyToSelectedLayer(item);
    });
    // 键盘可达：Enter / Space 明确执行「加到选中层」，与双击等价。
    card.addEventListener("keydown", function (event) {
      if (event.target !== card) return;
      if (
        event.key === "Enter" ||
        event.key === " " ||
        event.keyCode === 13 ||
        event.keyCode === 32
      ) {
        event.preventDefault();
        applyToSelectedLayer(item);
      }
    });
    return card;
  }

  var lazyCardObserver = null;

  /** 只创建视口附近的完整卡片；离屏项保留轻量槽位。 */
  function renderLazyCards(container, items, slotClass, factory) {
    if (!container) return;
    if (lazyCardObserver) lazyCardObserver.disconnect();
    container.textContent = "";

    function makeSlot(item) {
      var slot = document.createElement("div");
      var card = null;
      slot.className = "card-slot " + slotClass;
      slot.__mount = function () {
        if (card) return;
        card = factory(item);
        slot.appendChild(card);
        slot.classList.add("mounted");
      };
      slot.__unmount = function () {
        if (!card) return;
        stopAllPreviewPlayback();
        if (card.parentNode === slot) slot.removeChild(card);
        card = null;
        slot.classList.remove("mounted");
      };
      return slot;
    }

    if (!window.IntersectionObserver) {
      var all = document.createDocumentFragment();
      for (var a = 0; a < items.length; a++) {
        var fallbackSlot = makeSlot(items[a]);
        fallbackSlot.__mount();
        all.appendChild(fallbackSlot);
      }
      container.appendChild(all);
      return;
    }

    var scrollRoot = container.closest(".preset-main, main") || null;
    lazyCardObserver = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var slot = entries[i].target;
        if (entries[i].isIntersecting) slot.__mount();
        else slot.__unmount();
      }
    }, { root: scrollRoot, rootMargin: "400px 0px", threshold: 0.01 });

    var fragment = document.createDocumentFragment();
    var slots = [];
    for (var i = 0; i < items.length; i++) {
      var slot = makeSlot(items[i]);
      slots.push(slot);
      fragment.appendChild(slot);
    }
    container.appendChild(fragment);
    for (var j = 0; j < slots.length; j++) lazyCardObserver.observe(slots[j]);
    /* 首批卡片立即挂载，避免滚动到新页面时出现一帧空槽位。 */
    var initial = Math.min(slots.length, 12);
    for (var k = 0; k < initial; k++) slots[k].__mount();
  }

  /**
   * 把效果加到 AE 里当前选中的图层。
   *
   * 走引擎侧的 AEV_Apply.addToSelectedJson：那边负责找合成与选中层、
   * 挂效果、内置效果套显式配方（插件效果一个参数都不碰）。
   */
  function applyToSelectedLayer(item) {
    if (!state.extensionPath) {
      setStatus(state.lang === "zh" ? "扩展路径未知，请先点「重新扫描」" : "Unknown extension path", true);
      return;
    }
    var label = AEV_ViewModel.resolveName(item, state.lang);
    engine(
      "AEV_Apply.addToSelectedJson(" + JSON.stringify(item.matchName) + ")",
      function (result) {
        var data = parseEngineResult(result);
        if (!data || data.status !== "ok") {
          var reason = (data && data.reason) || "";
          var message;
          if (reason === "no_layer") {
            message = state.lang === "zh"
              ? "请先在 AE 里选中一个图层，再双击效果"
              : "Select a layer in AE first, then double-click an effect";
          } else if (reason === "no_comp") {
            message = state.lang === "zh"
              ? "AE 里没有打开的合成"
              : "No composition open in AE";
          } else {
            message = state.lang === "zh"
              ? "添加失败：" + reason
              : "Failed to add: " + reason;
          }
          setStatus(message, true);
          return;
        }
        setStatus(
          (state.lang === "zh" ? "已把「" : "Added ") +
            label +
            (state.lang === "zh" ? "」加到图层「" : "\" to layer \"") +
            (data.layer || "?") +
            (state.lang === "zh" ? "」" : "\""),
          false
        );
      }
    );
  }

  function render() {
    stopAllPreviewPlayback();
    var visible = AEV_ViewModel.filterItems(state.items, {
      lang: state.lang,
      query: state.query,
      plugin: state.plugin
    });
    var sidebarItems = visible;
    // 分类与收藏是两个独立条件，可以同时生效。
    if (state.category) {
      var narrowed = [];
      for (var c = 0; c < visible.length; c++) {
        if (AEV_ViewModel.categoryKey(visible[c]) === state.category) {
          narrowed.push(visible[c]);
        }
      }
      visible = narrowed;
    }
    if (state.effectFavoritesOnly) {
      var favoriteItems = [];
      for (var f = 0; f < visible.length; f++) {
        if (isFavorite("effects", visible[f].matchName)) favoriteItems.push(visible[f]);
      }
      visible = favoriteItems;
    }
    // 排序（默认按名称首字母）
    visible = AEV_ViewModel.sortItems(visible, state.sortMode, state.lang);

    var grid = byId("previewGrid");
    var empty = byId("emptyState");
    renderLazyCards(grid, visible, "effect-slot", createCard);
    empty.hidden = visible.length !== 0;
    byId("selectionStats").textContent =
      (state.lang === "zh" ? "显示 " : "Showing ") + visible.length;
    renderSidebar(sidebarItems);
  }

  /**
   * 左侧分类栏。
   * 分类顺序取自 AE 菜单（catalog 里首次出现的顺序），
   * 计数取当前插件筛选后的结果，所以切来源时数字会跟着变。
   */
  function renderSidebar(visible) {
    var list = byId("categoryList");
    if (!list) return;
    var stats = AEV_ViewModel.categoryCounts(visible, state.lang);
    var order = state.categoryOrder.length
      ? state.categoryOrder
      : Object.keys(stats.counts);

    list.textContent = "";
    var total = visible.length;
    var favoriteCount = 0;
    for (var f = 0; f < visible.length; f++) {
      if (isFavorite("effects", visible[f].matchName)) favoriteCount++;
    }

    list.appendChild(
      categoryButton("__favorites__", L("favorites.filter"), favoriteCount, state.effectFavoritesOnly, true)
    );
    list.appendChild(
      categoryButton("", state.lang === "zh" ? "全部分类" : "All categories", total, !state.category, false)
    );

    for (var i = 0; i < order.length; i++) {
      var key = order[i];
      var count = stats.counts[key];
      if (!count) continue;
      var label = stats.labels[key] || key;
      list.appendChild(categoryButton(key, label, count, state.category === key, false));
    }

    // catalog 里没有但确实存在的分类（理论上不会出现）兜底追加
    var extra = [];
    for (var name in stats.counts) {
      if (order.indexOf(name) < 0) extra.push(name);
    }
    for (var e = 0; e < extra.length; e++) {
      list.appendChild(
        categoryButton(extra[e], stats.labels[extra[e]] || extra[e], stats.counts[extra[e]], state.category === extra[e], false)
      );
    }
  }

  function categoryButton(key, label, count, active, favoriteRow) {
    var li = document.createElement("li");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "category-item" +
      (favoriteRow ? " favorite-category" : "") +
      (active ? " active" : "");
    button.setAttribute("data-key", key);

    var text = document.createElement("span");
    text.className = "category-label";
    text.textContent = label;

    var badge = document.createElement("span");
    badge.className = "category-count";
    badge.textContent = String(count);

    button.appendChild(text);
    button.appendChild(badge);
    button.addEventListener("click", function () {
      if (favoriteRow) state.effectFavoritesOnly = !state.effectFavoritesOnly;
      else state.category = key;
      render();
    });
    li.appendChild(button);
    return li;
  }

  function updateHeader() {
    var previewCount = Object.keys(state.previews).length;
    byId("libraryStats").textContent =
      (state.lang === "zh" ? "内置预览 " : "Previews ") +
      previewCount +
      (state.lang === "zh" ? " · 本机效果 " : " · Installed ") +
      state.catalog.length;
  }

  /** 取当前语言的文案。args 可选，替换 {0} {1}…；字典在 js/i18n.js */
  function L(key, args) {
    if (typeof AEV_t === "function") return AEV_t(key, state.lang, args);
    return key;
  }

  function setLanguage(lang) {
    state.lang = lang;
    byId("langZh").className = "segment" + (lang === "zh" ? " active" : "");
    byId("langEn").className = "segment" + (lang === "en" ? " active" : "");
    /* 静态文案：HTML 上标了 data-i18n 的全部换掉（设置页、队列、按钮 title…） */
    if (typeof AEV_applyI18n === "function") AEV_applyI18n(lang);
    /* 底栏那条是上一次操作留下的、用旧语言拼出来的字符串，
       语言一换它就不再匹配 —— 直接回到「就绪」 */
    setStatus(L("status.ready"), false);
    updateHeader();
    render();
    // 曲线视图的标签（预设下拉、提示语）跟着语言走
    if (window.AEV_CurveUI && typeof AEV_CurveUI.relang === "function") {
      AEV_CurveUI.relang();
    }
    if (window.AEV_MaterialsUI) AEV_MaterialsUI.setLanguage(lang);
    if (state.presets.length) renderPresetList();
    var presetDeleteText = byId("presetDeleteText");
    var presetDeleteDialog = byId("presetDeleteDialog");
    if (presetDeleteDialog && !presetDeleteDialog.hidden && presetDeleteText) {
      presetDeleteText.textContent = L("preset.deleteQuestion", [state.deletePresetName]);
    }
  }

  /**
   * 预览格尺寸。
   *
   * 为什么需要手动调：格子里的画面是按「整网等分」切出来的，
   * 一格永远精确等于一个预览框（不会串格）。但面板比例变化时，
   * 1fr 会把卡片拉宽到不同的实际像素宽度——同一张预览在宽面板上
   * 显得比窄面板上小，细节看不清。滑块让用户自己定一个合适的尺寸。
   *
   * 效果/预设滑块范围固定 48–360px，素材页固定 48–180px。
   *
   * 关键约束：**滑块标的值必须等于实际格子宽度**。
   * 设一个放不下的值（比如面板可用 150px 却要 180px 的格子），
   * grid 会把格子压到 150px，于是滑块标 180 而实际是 150 —— 对不上。
   * 所以按可用宽度收敛实际尺寸，并把收敛后的值写回滑块：
   *   · 面板变窄时自动把尺寸收敛到能放下的最大值，滑块同步回弹
   *   · 面板变宽时恢复用户原本选的尺寸
   */
  var THUMB_MIN = 48;
  var THUMB_MAX = 360;
  var MATERIAL_THUMB_MAX = 180;
  var THUMB_STEP = 2;
  var THUMB_COMPACT = 80;
  var thumbPreferred = { effects: 132, presets: 180, materials: 132 };

  function thumbMaxFor(view) {
    return view === "materials" ? MATERIAL_THUMB_MAX : THUMB_MAX;
  }

  function loadThumbPreferences() {
    if (!window.AEV_Prefs) return;
    for (var view in thumbPreferred) {
      if (!thumbPreferred.hasOwnProperty(view)) continue;
      var saved = AEV_Prefs.thumbSize(view);
      if (saved) thumbPreferred[view] = saved;
    }
  }

  function thumbGridId(view) {
    if (view === "effects") return "previewGrid";
    if (view === "presets") return "presetList";
    if (view === "materials") return "materialGrid";
    return "";
  }

  /** 当前视图的方块网格实际可用宽度 */
  function availableThumbWidth(view) {
    var grid = byId(thumbGridId(view));
    var width = grid ? grid.clientWidth : 0;
    if (!width || width <= 0) return THUMB_MAX;
    return Math.floor(width);
  }

  function setThumbSize(size, persist) {
    var view = state.view;
    if (!state.thumbSizes.hasOwnProperty(view)) return;
    var maxThumb = thumbMaxFor(view);
    var requested = Number(size);
    if (!isNaN(requested) && requested > 0) {
      thumbPreferred[view] = Math.max(THUMB_MIN, Math.min(maxThumb, requested));
      if (persist && window.AEV_Prefs) {
        AEV_Prefs.setThumbSize(view, thumbPreferred[view]);
      }
    }
    var limit = Math.min(maxThumb, availableThumbWidth(view));
    if (limit < THUMB_MIN) limit = THUMB_MIN;

    var value = Math.min(thumbPreferred[view], limit);
    value = Math.max(THUMB_MIN, value);
    // 对齐到滑块的 step 刻度（向下取整，保证不超过可用宽度），
    // 否则 range 会自动吸附 slider.value，标称与实际又会差 1px。
    value = THUMB_MIN + Math.floor((value - THUMB_MIN) / THUMB_STEP) * THUMB_STEP;

    state.thumbSizes[view] = value;
    document.documentElement.style.setProperty("--view-size", value + "px");
    var fontMain = Math.max(10, Math.min(18, value * 0.075));
    var fontMeta = Math.max(9, Math.min(13, value * 0.055));
    var textPad = Math.max(3, Math.min(10, value * 0.035));
    var textGap = Math.max(2, Math.min(6, value * 0.015));
    document.documentElement.style.setProperty("--card-font-main", fontMain.toFixed(1) + "px");
    document.documentElement.style.setProperty("--card-font-meta", fontMeta.toFixed(1) + "px");
    document.documentElement.style.setProperty("--card-text-pad", textPad.toFixed(1) + "px");
    document.documentElement.style.setProperty("--card-text-gap", textGap.toFixed(1) + "px");

    var grid = byId(thumbGridId(view));
    if (grid) grid.classList.toggle("compact", value < THUMB_COMPACT);

    var slider = byId("thumbSize");
    if (slider) {
      // 范围按视图固定；面板比例只影响「能否放到该尺寸」，不改变滑块刻度
      slider.min = String(THUMB_MIN);
      slider.max = String(maxThumb);
      slider.step = String(THUMB_STEP);
      // 收敛后把实际生效值写回，避免「标 180、实际 150」的错位
      slider.value = String(value);
    }
    var output = byId("thumbSizeValue");
    if (output) output.textContent = String(value);
  }

  function syncThumbControl(view) {
    var wrap = byId("sizeSliderWrap");
    var visible = view !== "curve";
    if (wrap) wrap.hidden = !visible;
    if (!visible || !state.thumbSizes.hasOwnProperty(view)) return;
    setThumbSize(thumbPreferred[view]);
  }

  function setSortMode(mode) {
    state.sortMode = mode;
    byId("sortName").className = "segment" + (mode === "name" ? " active" : "");
    byId("sortCategory").className = "segment" + (mode === "category" ? " active" : "");
    render();
  }

  function setStatus(text, isError) {
    var status = byId("statusText");
    status.textContent = text;
    // 底栏固定单行省略，长错误详情挂到 title 上仍能看全
    status.title = text;
    status.className = isError ? "error" : "";
  }

  /**
   * 重新读取当前预览与 AE 效果清单。
   * @param {function} done    完成回调
   * @param {boolean} force    true = 强制重扫 AE 效果清单
   */
  function refresh(done, force) {
    setStatus(state.lang === "zh" ? "正在扫描 AE 效果…" : "Scanning AE effects…", false);

    loadJson("data/names.json", function (namesError, namesData) {
      if (namesError) {
        finish(namesError);
        return;
      }
      var names = {};
      for (var i = 0; i < namesData.items.length; i++) {
        names[namesData.items[i].matchName] = namesData.items[i];
      }
      state.names = names;

      loadJson("data/manifest.json", function (manifestError, manifestData) {
        if (manifestError) {
          finish(manifestError);
          return;
        }
        state.manifest = manifestData;
        state.previews = {};
        state.previewVariants = {};
        var columns = manifestData.columns || 8;
        var cellSize = manifestData.cellSize || 256;
        // sheets 数组的顺序不等于它的 index 字段（打包器按落盘顺序追加），
        // 所以必须按 index 建索引，不能直接用 sheets[preview.sheet]。
        var sheetByIndex = {};
        var sheetList = manifestData.sheets || [];
        for (var sh = 0; sh < sheetList.length; sh++) {
          sheetByIndex[sheetList[sh].index] = sheetList[sh];
        }
        for (var p = 0; p < manifestData.items.length; p++) {
          var preview = manifestData.items[p];
          if (!preview.src) {
            var sheet = sheetByIndex[preview.sheet] || {};
            preview.src = sheet.src || "";
          }
          addPreviewVariant(preview);
        }

        // ---- 插件 L2 预览（可选索引，首次安装时不存在） ----
        // 只合入显示用的 state.previews；面板不写回任何预览索引。
        loadOptionalJson("data/plugin_manifest.json", function (pluginData) {
          loadOptionalJson("data/plugin_blacklist.json", function (blacklistData) {
            state.pluginBlacklist = {};
            var blackItems = (blacklistData && blacklistData.items) || [];
            for (var b = 0; b < blackItems.length; b++) {
              state.pluginBlacklist[blackItems[b].matchName] =
                blackItems[b].reason || "crash";
            }

            state.pluginPreviewCount = 0;
            var pluginItems = (pluginData && pluginData.items) || [];
            for (var q = 0; q < pluginItems.length; q++) {
              var pluginPreview = pluginItems[q];
              // 帧序列的第 0 帧作为 src 兜底（静止时不依赖轮播）
              if (!pluginPreview.src && pluginPreview.frameSrc) {
                pluginPreview.src = pluginPreview.frameSrc.replace("%04d", "0000");
              }
              addPreviewVariant(pluginPreview);
              state.pluginPreviewCount++;
            }

            // 静态预览名单：这些条目各帧内容完全相同，播起来只会闪。
            // 由 tools/mark_animated.mjs 生成；没有这个文件时全部当动态。
            loadOptionalJson("data/animated.json", function (animData) {
              state.staticPreviews = {};
              var animItems = (animData && animData.items) || [];
              for (var an = 0; an < animItems.length; an++) {
                if (animItems[an].animated === false) {
                  state.staticPreviews[animItems[an].matchName] = true;
                }
              }

              getCatalog(function (catalogError, catalogData) {
                if (catalogError) {
                  finish(catalogError);
                  return;
                }
                state.catalog = catalogData.effects;
                selectPreviews();
                // 分类顺序 = AE 菜单里的顺序（catalog 里各类首次出现的次序）
                state.categoryOrder = AEV_ViewModel.categoryOrder(state.catalog);
                checkStale(function () {
                  rebuildItems();
                  updateHeader();
                  render();
                  var staleCount = Object.keys(state.stale).length;
                  var ready = state.lang === "zh" ? "效果库已就绪" : "Library ready";
                  if (staleCount > 0) {
                    ready +=
                      state.lang === "zh"
                        ? "（" + staleCount + " 张预览待刷新）"
                        : " (" + staleCount + " previews stale)";
                  }
                  setStatus(ready, false);
                  if (done) done(null);
                });
              }, force);
            });
          });
        });
      });
    });

    function finish(error) {
      setStatus(String(error.message || error), true);
      if (done) done(error);
    }
  }

  /* ---------- 生成队列：与 engine/*.jsx 的唯一交互面 ---------- */

  function parseEngineResult(text) {
    if (!text) return { status: "error", reason: "empty_result" };
    if (text.indexOf("ERR") === 0) return { status: "error", reason: text };
    try {
      return JSON.parse(text);
    } catch (error) {
      return { status: "error", reason: "bad_json" };
    }
  }

  function engine(expr, callback) {
    Bridge.runEngine(state.extensionPath, expr, callback);
  }

  /** 向 AE 侧核对缓存指纹：哪些预览是「图还在但配方/素材变了」。
   *  没有这条，改了配方就只能靠人工删图重渲，用户永远不知道旧图已经不代表当前配方。
   */
  function checkStale(callback) {
    state.stale = {};
    if (!state.extensionPath) {
      callback();
      return;
    }
    engine(
      "AEV_PreviewGen.staleList(" +
        JSON.stringify(state.extensionPath) + "," +
        JSON.stringify(state.effectBackground) +
        ")",
      function (result) {
        var data = parseEngineResult(result);
        if (data && data.stale) {
          for (var i = 0; i < data.stale.length; i++) {
            state.stale[data.stale[i]] = true;
          }
        }
        callback();
      }
    );
  }

  function zeroPad(value, width) {
    var text = String(value);
    while (text.length < width) text = "0" + text;
    return text;
  }

  /** 帧序列模板 "thumbs/batch_000_%04d.png" -> "data/thumbs/batch_000_0001.png" */
  function framePath(template, index) {
    return "data/" + String(template).replace("%04d", zeroPad(index, 4));
  }

  /* ---------- 帧预加载（消除首次悬停的闪烁） ---------- */

  /**
   * 预加载一串帧图，全部就绪后回调。
   *
   * 为什么必须预加载：切 background-image 到一个还没加载完的 URL 时，
   * 浏览器会先把旧背景撤掉、新的还没画上 —— 中间那一瞬只剩容器的底色，
   * 看上去就是「闪一下」。第一��悬停时 6 帧全都没缓存，于是连闪 6 下
   * （用户反馈：首次预览效果时会闪几下）。预加载后切换走的是已解码的
   * 缓存，不再有空档。
   *
   * 预加载用的 Image 与 CSS background-image 用同一个 URL，共享同一份
   * HTTP 缓存，所以两者不会各拉一份。
   */
  var frameImages = {};
  var activePreviewStops = [];
  var previewSuppressUntil = 0;

  function stopAllPreviewPlayback() {
    var stops = activePreviewStops;
    activePreviewStops = [];
    for (var i = 0; i < stops.length; i++) {
      try { stops[i](); } catch (e) {}
    }
  }

  function suppressPreviewPlayback() {
    previewSuppressUntil = Date.now() + 260;
    stopAllPreviewPlayback();
  }

  document.addEventListener("wheel", suppressPreviewPlayback, { passive: true });
  document.addEventListener("scroll", suppressPreviewPlayback, true);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) suppressPreviewPlayback();
  });

  function frameImage(url) {
    var img = frameImages[url];
    if (img) return img;
    img = new Image();
    img.src = url;
    frameImages[url] = img;
    return img;
  }

  function preloadFrames(urls, callback) {
    var pending = urls.length;
    if (pending === 0) {
      callback();
      return;
    }
    var done = false;
    function settle() {
      pending--;
      if (pending <= 0 && !done) {
        done = true;
        callback();
      }
    }
    for (var i = 0; i < urls.length; i++) {
      var img = frameImage(urls[i]);
      if (img.complete) {
        settle();
      } else {
        img.addEventListener("load", settle, { once: true });
        img.addEventListener("error", settle, { once: true });
      }
    }
  }

  /* ---------- 预设库（M3） ---------- */

  /* 预设预览的独立索引（不进 L1 的 manifest.json，由离线工具维护）。
     面板生成的内置预设 + 离线脚本生成的插件预设，两份合并；离线条目优先。 */
  function loadPresetIndex(done) {
    loadOptionalJson("data/preset_manifest.json", function (data) {
      state.presetPreviews = {};
      var items = (data && data.items) || [];
      for (var i = 0; i < items.length; i++) {
        state.presetPreviews[items[i].name] = items[i];
      }
      loadOptionalJson("data/preset_plugin_manifest.json", function (pluginData) {
        var pluginItems = (pluginData && pluginData.items) || [];
        for (var q = 0; q < pluginItems.length; q++) {
          state.presetPreviews[pluginItems[q].name] = pluginItems[q];
        }
        if (done) done();
      });
    });
  }

  function updatePresetOrganizer(data) {
    var doc = data && typeof data === "object" ? data : {};
    state.presetOrganizer = {
      categories: doc.categories || [],
      assignments: doc.assignments || {},
      favorites: doc.favorites || {}
    };
  }

  function presetCategories() {
    return state.presetOrganizer.categories || [];
  }

  function presetCategoryFor(path) {
    var key = AEV_Prefs.pathKey(path);
    return String((state.presetOrganizer.assignments || {})[key] || "");
  }

  function loadPresetOrganizer(done) {
    engine("AEV_PresetCategories.loadJson()", function (result) {
      var data = parseEngineResult(result);
      updatePresetOrganizer(data);
      if (!AEV_Prefs) {
        if (done) done();
        return;
      }

      var legacy = AEV_Prefs.presetOrganizerJson();
      var legacyDoc = parseEngineResult(legacy);
      var hasLegacyCategories =
        legacyDoc && legacyDoc.categories && legacyDoc.categories.length;
      var finish = function () {
        var legacyFavorites = AEV_Prefs.presetFavoritePathsJson();
        var rows = parseEngineResult(legacyFavorites);
        if (!rows || !rows.length) {
          if (done) done();
          return;
        }
        engine(
          "AEV_PresetCategories.importFavoritesJson(" + JSON.stringify(legacyFavorites) + ")",
          function (migrated) {
            var favoriteDoc = parseEngineResult(migrated);
            if (favoriteDoc && favoriteDoc.status !== "error") {
              updatePresetOrganizer(favoriteDoc);
              AEV_Prefs.clearPresetFavorites();
            }
            if (done) done();
          }
        );
      };

      if (!presetCategories().length && hasLegacyCategories) {
        engine("AEV_PresetCategories.importJson(" + JSON.stringify(legacy) + ")", function (migrated) {
          updatePresetOrganizer(parseEngineResult(migrated));
          finish();
        });
      } else {
        finish();
      }
    });
  }

  /** 载入用户自建的预设库（我的文档/DreamEngine/presets） */
  function loadPresetLibrary(done, skipRender) {
    if (!state.extensionPath) {
      if (done) done();
      return;
    }
    loadPresetOrganizer(function () {
      engine("AEV_Presets.libraryJson()", function (result) {
        var data = parseEngineResult(result);
        if (!data || data.status !== "ok") {
          setStatus(
            state.lang === "zh" ? "读取预设库失败" : "Failed to read preset library",
            true
          );
          if (done) done();
          return;
        }
        state.presets = data.items || [];
        state.presetFolder = data.folder || "";
        loadPresetIndex(function () {
          if (!skipRender || state.view === "presets") renderPresetList();
          if (done) done();
        });
      });
    });
  }

  function renderPresetList() {
    stopAllPreviewPlayback();
    var list = byId("presetList");
    if (!list) return;
    var query = String(state.presetQuery || "").toLowerCase();
    var base = [];
    for (var b = 0; b < state.presets.length; b++) {
      var baseItem = state.presets[b];
      if (query && String(baseItem.name + " " + baseItem.category).toLowerCase().indexOf(query) === -1) {
        continue;
      }
      base.push(baseItem);
    }
    renderPresetSidebar(base);

    var visible = [];
    for (var v = 0; v < base.length; v++) {
      var presetItem = base[v];
      var categoryId = presetCategoryFor(presetItem.path);
      if (state.presetCategory === "__uncategorized__") {
        if (presetItem.external) continue;
        if (categoryId) continue;
      } else if (state.presetCategory.indexOf("ae:") === 0) {
        if (!presetItem.external ||
            (presetItem.source || "AE 内置") !== state.presetCategory.substring(3)) {
          continue;
        }
      } else if (state.presetCategory !== "all") {
        if (presetItem.external || categoryId !== state.presetCategory) continue;
      }
      if (state.presetFavoritesOnly && !isFavorite("presets", presetItem.path)) continue;
      visible.push(presetItem);
    }
    var locale = state.lang === "zh" ? "zh-Hans-CN" : "en";
    visible.sort(function (a, c) {
      return String(a.name).localeCompare(String(c.name), locale);
    });

    function createPresetCard(item) {
      var card = document.createElement("div");
      card.className = "preset-card";
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");

      var thumb = document.createElement("div");
      thumb.className = "preset-thumb";
      var preview = state.presetPreviews[item.name];
      var animated = !!(
        preview && preview.animated !== false && (preview.frames || 1) > 1
      );
      if (preview) {
        // 静态预设就显示第 0 帧、不绑 hover；动态预设沿用效果卡的
        // 预加载 + 轮播逻辑（静止时停在最后一帧）。
        attachPreview(thumb, card, preview, animated, animated ? undefined : 0);
        if (!animated) {
          var staticDot = document.createElement("span");
          staticDot.className = "preset-static-dot";
          staticDot.title = state.lang === "zh" ? "静止帧" : "Still frame";
          thumb.appendChild(staticDot);
        }
      } else {
        var placeholder = document.createElement("span");
        placeholder.className = "thumb-placeholder";
        placeholder.textContent = state.lang === "zh" ? "无预览" : "No preview";
        thumb.appendChild(placeholder);
      }
      thumb.appendChild(favoriteButton("presets", item.path, renderPresetList));

      if (!item.external) (function (preset) {
        var categoryButton = document.createElement("button");
        categoryButton.type = "button";
        categoryButton.className = "preset-category-toggle";
        categoryButton.title = L("preset.moveCategory");
        categoryButton.setAttribute("aria-label", L("preset.moveCategory"));
        var folderSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        folderSvg.setAttribute("viewBox", "0 0 24 24");
        folderSvg.setAttribute("aria-hidden", "true");
        var folderPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        folderPath.setAttribute("d", "M3 7h7l2 2h9v10H3z");
        folderSvg.appendChild(folderPath);
        categoryButton.appendChild(folderSvg);
        categoryButton.addEventListener("click", function (event) {
          event.stopPropagation();
          var rect = event.currentTarget.getBoundingClientRect();
          openPresetCategoryMenu(preset, rect.left, rect.bottom + 4);
        });
        categoryButton.addEventListener("dblclick", function (event) {
          event.stopPropagation();
        });
        card.appendChild(categoryButton);
      })(item);

      var badge = null;
      if (!preview) {
        badge = document.createElement("span");
        badge.className = "preset-badge static";
        badge.textContent = state.lang === "zh" ? "未生成" : "No preview";
      }

      var name = document.createElement("span");
      name.className = "preset-name";
      name.textContent = item.name;

      var category = document.createElement("span");
      category.className = "preset-category";
      category.textContent = item.external
        ? "AE · " + (item.source || "外部预设")
        : presetCategoryLabel(item) || item.category || L("preset.fallbackCategory");

      card.appendChild(thumb);
      if (badge) card.appendChild(badge);
      card.appendChild(name);
      card.appendChild(category);
      bindPresetItem(card, item);
      return card;
    }
    renderLazyCards(list, visible, "preset-slot", createPresetCard);
  }

  function bindPresetItem(button, item) {
    button.addEventListener("pointerdown", function (event) {
      if (item.external) return;
      if (event.button !== undefined && event.button !== 0) return;
      if (event.target && event.target.closest &&
          event.target.closest(".favorite-toggle,.preset-category-toggle")) {
        return;
      }
      startPresetHold(item);
    });
    button.addEventListener("pointerup", cancelPresetHold);
    button.addEventListener("pointerleave", cancelPresetHold);
    button.addEventListener("pointercancel", cancelPresetHold);
    button.addEventListener("click", function (event) {
      // 双击会连续触发两次 click；第一次已经应用，忽略后续 click。
      if (event.detail > 1) {
        event.preventDefault();
        return;
      }
      if (state.presetHoldTriggeredPath === item.path) {
        state.presetHoldTriggeredPath = "";
        event.preventDefault();
        return;
      }
      if (event.target && event.target.closest &&
          event.target.closest(".favorite-toggle,.preset-category-toggle")) {
        return;
      }
      applyPreset(item);
    });
    button.addEventListener("contextmenu", function (event) {
      if (item.external) return;
      event.preventDefault();
      openPresetCategoryMenu(item, event.clientX, event.clientY);
    });
    button.addEventListener("keydown", function (event) {
      if (event.target !== button) return;
      if (
        event.key === "Enter" ||
        event.key === " " ||
        event.keyCode === 13 ||
        event.keyCode === 32
      ) {
        event.preventDefault();
        applyPreset(item);
      }
    });
  }

  function startPresetHold(item) {
    cancelPresetHold();
    state.presetHoldTimer = setTimeout(function () {
      state.presetHoldTimer = null;
      state.presetHoldTriggeredPath = item.path;
      openDeletePreset(item);
    }, 650);
  }

  function cancelPresetHold() {
    if (!state.presetHoldTimer) return;
    clearTimeout(state.presetHoldTimer);
    state.presetHoldTimer = null;
  }

  function openDeletePreset(item) {
    var dialog = byId("presetDeleteDialog");
    var text = byId("presetDeleteText");
    if (!dialog || !text) return;
    state.deletePresetPath = item.path;
    state.deletePresetName = item.name;
    text.textContent = L("preset.deleteQuestion", [item.name]);
    var confirm = byId("presetDeleteConfirm");
    if (confirm) confirm.disabled = false;
    dialog.hidden = false;
  }

  function closeDeletePreset() {
    cancelPresetHold();
    state.deletePresetPath = "";
    state.deletePresetName = "";
    state.presetHoldTriggeredPath = "";
    var dialog = byId("presetDeleteDialog");
    if (dialog) dialog.hidden = true;
  }

  function deletePreset() {
    var path = state.deletePresetPath;
    var name = state.deletePresetName;
    if (!path || !state.extensionPath) return;
    var confirm = byId("presetDeleteConfirm");
    if (confirm) confirm.disabled = true;
    engine("AEV_Presets.deleteJson(" + JSON.stringify(path) + ")", function (result) {
      var data = parseEngineResult(result);
      if (data && data.status === "ok") {
        closeDeletePreset();
        setStatus(L("preset.deleted", [name]), false);
        loadPresetLibrary();
        return;
      }
      if (confirm) confirm.disabled = false;
      setStatus(L("preset.deleteFailed", [data && data.reason ? data.reason : L("msg.unknown")]), true);
    });
  }

  function presetCategoryLabel(item) {
    var id = presetCategoryFor(item.path);
    if (!id) return "";
    var rows = presetCategories();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].id === id) return rows[i].name;
    }
    return "";
  }

  function renderPresetSidebar(items) {
    var list = byId("presetCategories");
    if (!list) return;
    list.textContent = "";
    var categories = presetCategories();
    var favoriteCount = 0;
    var uncategorized = 0;
    var counts = {};
    var aeCounts = {};
    for (var i = 0; i < items.length; i++) {
      if (isFavorite("presets", items[i].path)) favoriteCount++;
      if (items[i].external) {
        var source = items[i].source || "AE 内置";
        aeCounts[source] = (aeCounts[source] || 0) + 1;
        continue;
      }
      var categoryId = presetCategoryFor(items[i].path);
      if (!categoryId) uncategorized++;
      else counts[categoryId] = (counts[categoryId] || 0) + 1;
    }

    list.appendChild(presetSidebarRow(
      "__favorites__", L("favorites.filter"), favoriteCount, true
    ));
    list.appendChild(presetSidebarRow(
      "all", L("preset.allCategories"), items.length, false
    ));
    list.appendChild(presetSidebarRow(
      "__uncategorized__", L("preset.uncategorized"), uncategorized, false
    ));
    for (var c = 0; c < categories.length; c++) {
      list.appendChild(presetSidebarRow(
        categories[c].id,
        categories[c].name,
        counts[categories[c].id] || 0,
        false,
        categories[c]
      ));
    }
    var aeSources = [];
    for (var sourceName in aeCounts) {
      if (aeCounts.hasOwnProperty(sourceName)) aeSources.push(sourceName);
    }
    aeSources.sort(function (a, b) {
      if (aeCounts[a] !== aeCounts[b]) return aeCounts[b] - aeCounts[a];
      return a.localeCompare(b, state.lang === "zh" ? "zh-Hans-CN" : "en");
    });
    if (aeSources.length) {
      var aeTitle = document.createElement("li");
      aeTitle.className = "sidebar-group-title";
      aeTitle.textContent = state.lang === "zh" ? "AE 预设分类" : "AE preset categories";
      list.appendChild(aeTitle);
      for (var ae = 0; ae < aeSources.length; ae++) {
        list.appendChild(presetSidebarRow(
          "ae:" + aeSources[ae],
          aeSources[ae],
          aeCounts[aeSources[ae]],
          false
        ));
      }
    }
  }

  function presetSidebarRow(id, label, count, favoriteRow, category) {
    var li = document.createElement("li");
    var button = document.createElement("button");
    button.type = "button";
    button.className = "category-item" +
      (favoriteRow ? " favorite-category" : "") +
      ((favoriteRow ? state.presetFavoritesOnly : state.presetCategory === id) ? " active" : "");
    button.appendChild(textSpan("category-label", label));
    button.appendChild(textSpan("category-count", String(count)));
    button.addEventListener("click", function () {
      if (favoriteRow) {
        state.presetFavoritesOnly = !state.presetFavoritesOnly;
        state.presetCategory = "all";
      } else {
        state.presetCategory = id;
      }
      renderPresetList();
    });
    if (category) {
      button.title = label;
      button.addEventListener("contextmenu", function (event) {
        event.preventDefault();
        openPresetCategoryAdminMenu(category, event.clientX, event.clientY);
      });
    }
    li.appendChild(button);
    return li;
  }

  function textSpan(className, text) {
    var node = document.createElement("span");
    node.className = className;
    node.textContent = text;
    return node;
  }

  function hidePresetCategoryMenu() {
    var menu = byId("presetCategoryMenu");
    if (menu) menu.hidden = true;
  }

  function showPresetCategoryMenu(x, y) {
    var menu = byId("presetCategoryMenu");
    if (!menu) return;
    menu.hidden = false;
    var width = menu.offsetWidth || 190;
    var height = menu.offsetHeight || 0;
    var left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
    var top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  function menuTitle(text) {
    var title = document.createElement("div");
    title.className = "preset-category-menu-title";
    title.textContent = text;
    return title;
  }

  function menuButton(label, active, danger, onClick) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = (active ? "active" : "") + (danger ? " danger" : "");
    button.appendChild(textSpan("", label));
    button.addEventListener("click", function () {
      hidePresetCategoryMenu();
      onClick();
    });
    return button;
  }

  function openPresetCategoryMenu(item, x, y) {
    var menu = byId("presetCategoryMenu");
    if (!menu) return;
    menu.textContent = "";
    menu.appendChild(menuTitle(L("preset.moveCategory")));
    var current = presetCategoryFor(item.path);
    menu.appendChild(menuButton(L("preset.uncategorized"), !current, false, function () {
      engine(
        "AEV_PresetCategories.assignJson(" + JSON.stringify(item.path) + ',"")',
        function (result) {
          updatePresetOrganizer(parseEngineResult(result));
          renderPresetList();
        }
      );
    }));
    var categories = presetCategories();
    for (var i = 0; i < categories.length; i++) {
      (function (category) {
        menu.appendChild(menuButton(category.name, current === category.id, false, function () {
          engine(
            "AEV_PresetCategories.assignJson(" +
              JSON.stringify(item.path) + "," + JSON.stringify(category.id) + ")",
            function (result) {
              updatePresetOrganizer(parseEngineResult(result));
              renderPresetList();
            }
          );
        }));
      })(categories[i]);
    }
    showPresetCategoryMenu(x, y);
  }

  function openPresetCategoryAdminMenu(category, x, y) {
    var menu = byId("presetCategoryMenu");
    if (!menu) return;
    menu.textContent = "";
    menu.appendChild(menuTitle(category.name));
    menu.appendChild(menuButton(L("preset.renameCategory"), false, false, function () {
      openPresetCategoryEditor("rename", category);
    }));
    menu.appendChild(menuButton(L("preset.deleteCategory"), false, true, function () {
      engine(
        "AEV_PresetCategories.deleteJson(" + JSON.stringify(category.id) + ")",
        function (result) {
          var data = parseEngineResult(result);
          if (!data || data.status === "error") return;
          updatePresetOrganizer(data);
          if (state.presetCategory === category.id) state.presetCategory = "all";
          setStatus(L("preset.categoryDeleted"), false);
          renderPresetList();
        }
      );
    }));
    showPresetCategoryMenu(x, y);
  }

  function openPresetCategoryEditor(mode, category) {
    var form = byId("presetCategoryEditor");
    var input = byId("presetCategoryName");
    if (!form || !input) return;
    state.presetEditorMode = mode;
    state.presetEditingId = category ? category.id : "";
    form.hidden = false;
    input.value = category ? category.name : "";
    try { input.focus(); } catch (e) {}
    try { input.select(); } catch (e2) {}
  }

  function closePresetCategoryEditor() {
    var form = byId("presetCategoryEditor");
    var input = byId("presetCategoryName");
    if (form) form.hidden = true;
    if (input) input.value = "";
    state.presetEditingId = "";
  }

  function savePresetCategory(event) {
    if (event) event.preventDefault();
    var input = byId("presetCategoryName");
    if (!input) return;
    var name = String(input.value || "").replace(/^\s+|\s+$/g, "");
    if (!name) return;
    var rename = state.presetEditorMode === "rename";
    var expr = rename
      ? "AEV_PresetCategories.renameJson(" +
        JSON.stringify(state.presetEditingId) + "," + JSON.stringify(name) + ")"
      : "AEV_PresetCategories.createJson(" + JSON.stringify(name) + ")";
    engine(expr, function (result) {
      var data = parseEngineResult(result);
      if (!data || data.status === "error") {
        setStatus(L("preset.categoryExists"), true);
        return;
      }
      updatePresetOrganizer(data);
      closePresetCategoryEditor();
      setStatus(
        rename ? L("preset.categoryRenamed") : L("preset.categoryCreated", [name]),
        false
      );
      renderPresetList();
    });
  }

  /**
   * 把预设应用到 AE 当前合成。
   * 走 engine 侧的安全包装：只选目标层、比对效果数、按类型顺序重试、
   * 自动新建的图层用 remove() 删掉（依据 T0.4 实测结论）。
   */
  function applyPreset(item) {
    if (!state.extensionPath) return;
    engine("AEV_Presets.contextJson()", function (ctxResult) {
      var ctx = parseEngineResult(ctxResult);
      if (!ctx || !ctx.comp) {
        setStatus(
          state.lang === "zh" ? "请先在 AE 里选中一个合成" : "Select a composition in AE first",
          true
        );
        return;
      }
      setStatus(state.lang === "zh" ? "正在应用预设…" : "Applying preset…", false);
      engine(
        "AEV_Presets.applyJson(" +
          JSON.stringify(ctx.comp) + "," +
          JSON.stringify(item.path) + "," +
          (Number(ctx.layer) || 0) + ")",
        function (applyResult) {
          var data = parseEngineResult(applyResult);
          if (data && data.status === "ok" && data.best) {
            setStatus(L("preset.applied", [item.name, data.best.kind, data.best.effects]), false);
            checkPresetDependencies(ctx.comp);
          } else {
            var attempts = (data && data.attempts) || [];
            setStatus(L("preset.notApplied", [attempts.join(" | ") || L("msg.unknown")]), true);
          }
        }
      );
    });
  }

  /** 依赖检查：合成里用到但本机没装的效果（通常是缺插件） */
  function checkPresetDependencies(compName) {
    engine("AEV_Presets.dependenciesJson(" + JSON.stringify(compName) + ")", function (result) {
      var data = parseEngineResult(result);
      if (!data || data.status !== "ok") return;
      var missing = data.missing || [];
      if (missing.length) {
        setStatus(L("preset.missingPlugins", [
          missing.length,
          missing.slice(0, 3).join(state.lang === "zh" ? "、" : ", ")
        ]), true);
      }
    });
  }

  /**
   * 搜索框的展开/收起。
   *
   * 平时只显示一个小图标（面板可以拖得很窄，常驻的大输入框会把筛选栏
   * 挤爆）；点一下才展开输入框并聚焦。
   */
  function setSearchOpen(open, inputId, fieldId, toggleId) {
    var field = byId(fieldId);
    var toggle = byId(toggleId);
    var input = byId(inputId);
    if (!field || !toggle || !input) return;
    field.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      input.focus();
      input.select();
    }
  }

  /**
   * 搜索框的展开/收起交互。
   *
   * 收起靠「点击 search-wrap 之外的地方」判定 —— 用 document 上的
   * mousedown 监听 + contains 判断，比在 wrap 上挂 click 再看
   * event.target 可靠得多：点图标时 target 是按钮、点输入框时 target
   * 是 input，两个条件都不满足，收起逻辑永远不触发。
   *
   * 图标本身再点一次是「切换」：展开时收起，收起时展开。
   */
  function bindSearchToggle(toggleId, inputId, fieldId, wrapId) {
    var toggle = byId(toggleId);
    var input = byId(inputId);
    var field = byId(fieldId);
    var wrap = byId(wrapId);
    if (!toggle || !input || !field || !wrap) return;

    var isOpen = function () {
      return !field.hidden;
    };

    toggle.addEventListener("click", function () {
      if (isOpen()) {
        setSearchOpen(false, inputId, fieldId, toggleId);
      } else {
        setSearchOpen(true, inputId, fieldId, toggleId);
      }
    });

    input.addEventListener("keydown", function (event) {
      if (event.key === "Escape" || event.keyCode === 27) {
        event.stopPropagation();
        input.value = "";
        applySearch("");
        setSearchOpen(false, inputId, fieldId, toggleId);
        markSearchActive("");
      }
    });

    // 点到包装之外就收起。用 mousedown 而不是 click：
    // 点击时输入框可能已经失焦，且 mousedown 早于 blur，顺序更稳。
    document.addEventListener("mousedown", function (event) {
      if (!isOpen()) return;
      var target = event.target;
      if (target && wrap.contains && wrap.contains(target)) return;
      setSearchOpen(false, inputId, fieldId, toggleId);
    });
  }

  /**
   * 设置页开关。
   *
   * 齿轮按钮是「切换」语义；Esc 与点抽屉外都能收起。
   */
  function setSettingsOpen(open) {
    var drawer = byId("settingsDrawer");
    var trigger = byId("btnSettings");
    if (!drawer || !trigger) return;
    drawer.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
  }

  /**
   * 主视图切换：效果预览 / 预设预览 / 曲线编辑 / 素材库。
   *
   * 四个视图同级，切换栏固定在面板最上方。用表驱动而不是逐个写 if：
   * 以后再加视图（比如批量导入）只改这两张表。
   */
  /* ============================================================
   * 顶栏搜索：同一个输入框服务当前视图
   *
   * 效果 / 预设 / 素材三个页面原来各有一套搜索框（预设页还有自己的一套
   * 展开收起），位置和手感都不一致。现在只留顶栏这一个，按 state.view
   * 决定关键词送到谁那里。
   * ============================================================ */

  /* 占位文案跟着视图走；曲线页没有搜索，所以不在表里 */
  var SEARCH_PLACEHOLDER = {
    effects: "search.effects",
    presets: "preset.search",
    materials: "materials.search"
  };

  /** 当前视图已经输入的关键词：三个页面各存一份，切回来还在 */
  function currentSearchValue() {
    if (state.view === "presets") return state.presetQuery || "";
    if (state.view === "materials") {
      return window.AEV_MaterialsUI && window.AEV_MaterialsUI.getQuery
        ? window.AEV_MaterialsUI.getQuery() : "";
    }
    return state.query || "";
  }

  /** 把关键词送到当前视图对应的筛选入口 */
  function applySearch(value) {
    var query = String(value === undefined || value === null ? "" : value);
    if (state.view === "presets") {
      state.presetQuery = query;
      renderPresetList();
      return;
    }
    if (state.view === "materials") {
      if (window.AEV_MaterialsUI && window.AEV_MaterialsUI.setQuery) {
        window.AEV_MaterialsUI.setQuery(query);
      }
      return;
    }
    state.query = query;
    render();
  }

  /** 收起状态下也要能看出「有筛选条件」：图标上点一个强调色小点 */
  function markSearchActive(value) {
    var toggle = byId("searchToggle");
    if (!toggle) return;
    if (value) toggle.classList.add("has-query");
    else toggle.classList.remove("has-query");
  }

  /** 切视图 / 切语言时同步：显隐、占位文案、已输入内容、高亮 */
  function syncSearchBox() {
    var wrap = byId("searchWrap");
    var input = byId("searchInput");
    var toggle = byId("searchToggle");
    if (!wrap || !input) return;

    var key = SEARCH_PLACEHOLDER[state.view];
    wrap.hidden = !key;
    if (!key) return;

    input.setAttribute("data-i18n-ph", key);
    if (toggle) {
      toggle.setAttribute("data-i18n-title", key);
      toggle.setAttribute("data-i18n-aria", key);
    }
    if (typeof AEV_t === "function") {
      var text = AEV_t(key, state.lang);
      input.setAttribute("placeholder", text);
      if (toggle) {
        toggle.setAttribute("title", text);
        toggle.setAttribute("aria-label", text);
      }
    }

    /* 切视图就该换成那个视图自己的关键词：这里不能因为「焦点还在输入框里」
       就跳过 —— 点页签不会把焦点移走，跳过的话素材页会残留预设的搜索词。 */
    var value = currentSearchValue();
    input.value = value;
    markSearchActive(value);
  }

  var VIEW_TABS = { effects: "tabEffects", presets: "tabPresets", curve: "tabCurve", materials: "tabMaterials" };
  var VIEW_PANELS = { effects: "viewEffects", presets: "viewPresets", curve: "viewCurve", materials: "viewMaterials" };

  function setView(view) {
    var previous = state.view;
    if (previous !== view) stopAllPreviewPlayback();
    state.view = view;
    var key;
    for (key in VIEW_PANELS) {
      if (!VIEW_PANELS.hasOwnProperty(key)) continue;
      var panel = byId(VIEW_PANELS[key]);
      if (panel) panel.hidden = key !== view;
      var tab = byId(VIEW_TABS[key]);
      if (tab) {
        tab.className = "view-tab" + (key === view ? " active" : "");
        tab.setAttribute("aria-selected", key === view ? "true" : "false");
      }
    }
    // 效果墙专属的工具条在另外两个视图下没有意义（搜索的是效果不是预设/曲线）
    byId("effectControls").hidden = view !== "effects";
    // 顶栏搜索服务所有带搜索的视图（效果 / 预设 / 素材），曲线页隐藏。
    syncSearchBox();
    syncThumbControl(view);

    if (view === "effects") {
      // 切回来时重建效果墙：离开时把 DOM 清空了
      render();
    } else {
      // 离开效果墙时把几百张卡片从 DOM 里摘掉 —— 留着虽然看不见，
      // 但每次切回来都要重建，白白浪费一次建 hundreds 个节点的开销。
      var grid = byId("previewGrid");
      if (grid) grid.textContent = "";
    }

    if (view === "presets") {
      // 预设数据在面板载入时已经读过；这里只渲染缓存，不重新扫描。
      if (state.presets.length || state.presetFolder) renderPresetList();
      else loadPresetLibrary();
    }
    // 曲线视图是常驻的曲线模板：进入只重绘，不去读 AE（读只发生在按「应用」时）
    if (view === "curve" && window.AEV_CurveUI) AEV_CurveUI.enter();
    if (view === "materials" && window.AEV_MaterialsUI) AEV_MaterialsUI.enter();
    if (previous === "materials" && view !== "materials" && window.AEV_MaterialsUI) {
      AEV_MaterialsUI.leave();
    }
    if (previous === "presets" && view !== "presets") closeDeletePreset();
  }

  function boot() {
    loadThumbPreferences();
    if (window.AEV_Prefs) state.effectBackground = AEV_Prefs.effectBackground();
    // 首屏：把 data-i18n 的静态文案对齐到当前语言（默认中文，等价于无操作）
    if (typeof AEV_applyI18n === "function") AEV_applyI18n(state.lang);

    byId("langZh").addEventListener("click", function () { setLanguage("zh"); });
    byId("langEn").addEventListener("click", function () { setLanguage("en"); });
    byId("tabEffects").addEventListener("click", function () { setView("effects"); });
    byId("tabPresets").addEventListener("click", function () { setView("presets"); });
    byId("tabCurve").addEventListener("click", function () { setView("curve"); });
    byId("tabMaterials").addEventListener("click", function () { setView("materials"); });
    byId("sortName").addEventListener("click", function () { setSortMode("name"); });
    byId("sortCategory").addEventListener("click", function () { setSortMode("category"); });
    byId("searchInput").addEventListener("input", function () {
      applySearch(this.value);
      markSearchActive(this.value);
    });
    bindSearchToggle("searchToggle", "searchInput", "searchField", "searchWrap");
    byId("pluginFilter").addEventListener("change", function () {
      state.plugin = this.value;
      render();
    });
    byId("showAll").addEventListener("change", function () {
      state.showAll = this.checked;
      rebuildItems();
      render();
    });
    byId("btnSettings").addEventListener("click", function () {
      setSettingsOpen(byId("settingsDrawer").hidden);
    });
    byId("btnSettingsClose").addEventListener("click", function () {
      setSettingsOpen(false);
    });
    // Esc 关设置页；点在抽屉与齿轮之外也关。
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" || event.keyCode === 27) {
        if (!byId("settingsDrawer").hidden) setSettingsOpen(false);
        hidePresetCategoryMenu();
        closeDeletePreset();
      }
    });
    // "/" 聚焦效果搜索：键盘用户的快速入口，输入框里不拦截。
    document.addEventListener("keydown", function (event) {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      /* 曲线页没有搜索框，其余三个视图共用顶栏这一个 */
      var wrap = byId("searchWrap");
      if (!wrap || wrap.hidden) return;
      var target = event.target;
      var tag = target && target.tagName ? target.tagName.toLowerCase() : "";
      if (
        tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (target && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      setSearchOpen(true, "searchInput", "searchField", "searchToggle");
    });
    document.addEventListener("mousedown", function (event) {
      var drawer = byId("settingsDrawer");
      if (drawer.hidden) return;
      var target = event.target;
      var trigger = byId("btnSettings");
      if (trigger && trigger.contains && trigger.contains(target)) return;
      if (drawer.contains && drawer.contains(target)) return;
      setSettingsOpen(false);
    });
    byId("btnPresetCategoryAdd").addEventListener("click", function () {
      openPresetCategoryEditor("create", null);
    });
    byId("btnOpenHub").addEventListener("click", function () {
      var button = this;
      if (!window.Bridge || typeof Bridge.openHub !== "function") {
        setStatus(L("msg.hubMissing"), true);
        return;
      }
      button.disabled = true;
      setStatus(L("msg.hubOpening"), false);
      Bridge.openHub(function (result) {
        button.disabled = false;
        if (String(result || "").indexOf("OK:") === 0) {
          setStatus(L("msg.hubOpened"), false);
        } else {
          setStatus(L("msg.hubMissing"), true);
        }
      });
    });
    byId("presetCategoryEditor").addEventListener("submit", savePresetCategory);
    byId("presetCategoryCancel").addEventListener("click", closePresetCategoryEditor);
    byId("presetCategoryName").addEventListener("keydown", function (event) {
      if (event.key === "Escape" || event.keyCode === 27) {
        event.preventDefault();
        closePresetCategoryEditor();
      }
    });
    byId("presetDeleteCancel").addEventListener("click", closeDeletePreset);
    byId("presetDeleteConfirm").addEventListener("click", deletePreset);
    document.addEventListener("mousedown", function (event) {
      var menu = byId("presetCategoryMenu");
      if (!menu || menu.hidden) return;
      if (menu.contains && menu.contains(event.target)) return;
      hidePresetCategoryMenu();
    });
    byId("thumbSize").addEventListener("input", function () {
      setThumbSize(this.value, true);
    });
    syncThumbControl(state.view);

    // 曲线编辑器：面板把自己的引擎通道与状态栏注入进去，
    // curve.js 不直接依赖 Bridge / 本文件的私有状态（否则又是一处耦合）。
    if (window.AEV_CurveUI) {
      AEV_CurveUI.init({
        engine: engine,
        parse: parseEngineResult,
        status: setStatus,
        lang: function () { return state.lang; }
      });
    }

    /* 面板被拖宽或拖窄时重新收敛实际尺寸（各视图的滑块范围固定）。
       否则会出现「滑块标 180、实际只有 150」的错位。 */
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        syncThumbControl(state.view);
      }, 120);
    });

    refresh(function (error) {
      // 面板每次重新载入时只刷新一次；AE 运行期间不再轮询外部文件变化。
      // 同时清一次上一轮异常中断留下的 DE_* 临时对象。
      if (!error && state.extensionPath) {
        engine("AEV_PreviewGen.cleanupArtifacts()", function () {
          loadPresetLibrary(null, true);
        });
      } else {
        loadPresetLibrary(null, true);
      }
    });
  }

  document.addEventListener("DOMContentLoaded", boot);

  return {
    refresh: refresh,
    setLanguage: setLanguage
  };
})();
