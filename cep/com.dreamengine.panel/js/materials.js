/* ============================================================
 * materials.js —— 素材库视图
 *
 * CEP 只负责分类、卡片和媒体预览；目录扫描与 AE 导入全部走
 * engine/materials.jsx。
 *
 * 扫描层返回的是「递归扫描后的扁平 items」，每条带绝对 path。目录树完全
 * 在 UI 层从 path 派生：以 root 为基准按 "/" 切分，去掉最后一段文件名，
 * 剩下的就是各级文件夹。这样不需要扫描层额外返回目录节点，也不动 jsx。
 *
 * 语法：ES5（CEP 11 的老 CEF）：只用 var / function，不用箭头函数、
 * 模板字符串、let/const、可选链。
 * ============================================================ */

var AEV_MaterialsUI = (function () {
  var AUDIO_PREVIEW_VOLUME = 0.35;
  var AUDIO_FADE_IN_MS = 250;
  var AUDIO_FADE_OUT_MS = 200;
  var AUDIO_FADE_STEP_MS = 20;

  var state = {
    lang: "zh",
    items: [],
    root: "",
    dir: "",
    category: "all",
    favoritesOnly: false,
    query: "",
    loaded: false,
    extensionPath: "",
    activeMedia: null,
    videoTimer: null,
    clickTimer: null,
    selectedPath: "",
    waveformCache: {},
    waveformPending: {},
    waveformQueue: [],
    waveformBusy: false
  };

  function byId(id) { return document.getElementById(id); }
  function L(key, args) { return AEV_t(key, state.lang, args); }

  /* ---------- 路径工具：ExtendScript 给的是 "/" 分隔的绝对路径 ---------- */

  function normPath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
  }

  function pathKey(path) { return normPath(path).toLowerCase(); }

  function isUnder(path, dir) {
    return pathKey(path).indexOf(pathKey(dir) + "/") === 0;
  }

  function baseName(path) {
    var parts = normPath(path).split("/");
    return parts[parts.length - 1] || normPath(path);
  }

  function joinPath(dir, name) { return normPath(dir) + "/" + name; }

  function isInsideFolder() {
    var root = normPath(state.root);
    var dir = normPath(state.dir) || root;
    return !!root && pathKey(dir) !== pathKey(root) && isUnder(dir, root);
  }

  function goUp() {
    if (!isInsideFolder()) return;
    var root = normPath(state.root);
    var dir = normPath(state.dir);
    var at = dir.lastIndexOf("/");
    var parent = at > 0 ? dir.substring(0, at) : root;
    if (pathKey(parent) !== pathKey(root) && !isUnder(parent, root)) parent = root;
    state.dir = parent;
    state.selectedPath = "";
    render();
  }

  /* ---------- 从扁平 items 派生目录树 ----------
   * dirs        : 所有「有素材后代」的目录（含 root），刷新后用来校验当前目录
   * folderCounts: 每个目录下（递归）的素材数
   * direct      : 当前目录下的直接素材（不含子目录）
   * folders     : 当前目录下的直接子文件夹（含递归素材数），空文件夹不会出现
   */
  function buildTree() {
    var root = normPath(state.root);
    var dir = normPath(state.dir) || root;
    var dirKey = pathKey(dir);
    var dirs = {};
    var folderCounts = {};
    var childMap = {};
    var direct = [];
    if (root) dirs[pathKey(root)] = true;

    for (var i = 0; i < state.items.length; i++) {
      var item = state.items[i];
      var full = normPath(item.path);
      if (!root || !isUnder(full, root)) continue;
      var parts = full.substring(root.length + 1).split("/");
      if (!parts.length) continue;
      parts.pop();

      var parent = root;
      var k;
      for (k = 0; k < parts.length; k++) {
        parent = joinPath(parent, parts[k]);
        dirs[pathKey(parent)] = true;
        folderCounts[pathKey(parent)] = (folderCounts[pathKey(parent)] || 0) + 1;
      }

      if (pathKey(parent) === dirKey) {
        direct.push(item);
      } else if (isUnder(parent, dir)) {
        var childName = parent.substring(dir.length + 1).split("/")[0];
        if (!childName) continue;
        var childPath = joinPath(dir, childName);
        var childKey = pathKey(childPath);
        if (!childMap[childKey]) childMap[childKey] = { name: childName, path: childPath };
      }
    }

    var folders = [];
    for (var key in childMap) {
      if (childMap.hasOwnProperty(key)) {
        folders.push({
          name: childMap[key].name,
          path: childMap[key].path,
          count: folderCounts[key] || 0
        });
      }
    }
    folders.sort(function (a, b) {
      return pathKey(a.path) < pathKey(b.path) ? -1 : 1;
    });

    return { dirs: dirs, direct: direct, folders: folders };
  }

  /** 刷新后保留当前目录；若已不存在，逐级回退到最近一个仍存在的上级，最后回根。 */
  function resolveDir(dirs) {
    var root = normPath(state.root);
    if (!root) { state.dir = ""; return false; }
    var rootKey = pathKey(root);
    var candidate = normPath(state.dir) || root;
    var before = pathKey(state.dir);

    if (pathKey(candidate) !== rootKey &&
        pathKey(candidate).indexOf(rootKey + "/") !== 0) {
      state.dir = root;
      return pathKey(state.dir) !== before;
    }
    while (true) {
      if (dirs[pathKey(candidate)]) {
        state.dir = candidate;
        return pathKey(state.dir) !== before;
      }
      if (pathKey(candidate) === rootKey) break;
      var at = candidate.lastIndexOf("/");
      if (at < rootKey.length) break;
      candidate = candidate.substring(0, at);
    }
    state.dir = root;
    return pathKey(state.dir) !== before;
  }

  function run(expr, callback) {
    if (!state.extensionPath) {
      Bridge.getExtensionPath(function (path) {
        state.extensionPath = path || "";
        if (!state.extensionPath) {
          callback("ERR:no_extension_path");
          return;
        }
        Bridge.runEngine(state.extensionPath, expr, callback);
      });
      return;
    }
    Bridge.runEngine(state.extensionPath, expr, callback);
  }

  function parseResult(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return { status: "error", reason: String(text || e) };
    }
  }

  /** Old indices may contain URL-encoded File.name values from ExtendScript. */
  function displayName(name) {
    var text = String(name || "");
    try {
      return decodeURI(text);
    } catch (e) {
      return text;
    }
  }

  function normalizeItems(items) {
    var source = items || [];
    var out = [];
    for (var i = 0; i < source.length; i++) {
      if (!source[i] || source[i].exists === false) continue;
      source[i].name = displayName(source[i].name);
      out.push(source[i]);
    }
    return out;
  }

  function categoryRows(tree) {
    var counts = {
      favorites: 0,
      all: tree.direct.length,
      video: 0,
      image: 0,
      audio: 0,
      project: 0,
      script: 0
    };
    for (var i = 0; i < tree.direct.length; i++) {
      var type = tree.direct[i].type;
      if (counts[type] !== undefined) counts[type]++;
      if (isFavorite(tree.direct[i].path)) counts.favorites++;
    }
    return [
      { id: "__favorites__", label: L("favorites.filter"), count: counts.favorites },
      { id: "all", label: L("materials.all"), count: counts.all },
      { id: "video", label: L("materials.video"), count: counts.video },
      { id: "image", label: L("materials.image"), count: counts.image },
      { id: "audio", label: L("materials.audio"), count: counts.audio },
      { id: "project", label: L("materials.project"), count: counts.project },
      { id: "script", label: L("materials.script"), count: counts.script }
    ];
  }

  function renderCategories(tree) {
    var list = byId("materialCategories");
    if (!list) return;
    list.textContent = "";
    var rows = categoryRows(tree);
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        var active = row.id === "__favorites__" ? state.favoritesOnly : state.category === row.id;
        var li = document.createElement("li");
        li.className = "material-category" +
          (row.id === "__favorites__" ? " favorite-category" : "");

        var button = document.createElement("button");
        button.type = "button";
        button.className = "category-item material-category-button" +
          (row.id === "__favorites__" ? " favorite-category" : "") +
          (active ? " active" : "");
        button.setAttribute("data-category-id", row.id);
        button.setAttribute("aria-pressed", active ? "true" : "false");
        var accessibleLabel = row.label + " (" + row.count + ")";
        button.setAttribute("aria-label", accessibleLabel);
        button.title = accessibleLabel;
        appendCategoryIcon(button, row.id);
        button.appendChild(textNode("span", "material-category-count", String(row.count)));
        button.addEventListener("click", function () {
          if (row.id === "__favorites__") state.favoritesOnly = !state.favoritesOnly;
          else state.category = row.id;
          render();
        });
        li.appendChild(button);
        list.appendChild(li);
      })(rows[i]);
    }
  }

  function appendIconPath(svg, d) {
    var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }

  /** 固定图标轨道使用同一套 24px 描边图标，不依赖字体或 emoji。 */
  function appendCategoryIcon(button, id) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "material-category-icon");
    svg.setAttribute("aria-hidden", "true");
    if (id === "__favorites__") {
      appendIconPath(svg, "M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z");
    } else if (id === "all") {
      appendIconPath(svg, "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z");
    } else if (id === "video") {
      appendIconPath(svg, "M4 6h16v12H4zM10 9l5 3-5 3z");
    } else if (id === "image") {
      appendIconPath(svg, "M4 5h16v14H4zM7 16l3.5-4 2.5 3 2-2.5 3 3.5M9 9.5h.01");
    } else if (id === "audio") {
      appendIconPath(svg, "M4 14v-4M8 17V7M12 15V9M16 18V6M20 14v-4");
    } else if (id === "project") {
      appendIconPath(svg, "M4 7h16v13H4zM8 7L6 3M14 7l-2-4M20 7l-2-4M10 12l5 3-5 3z");
    } else if (id === "script") {
      appendIconPath(svg, "M4 5h16v14H4zM8 9l3 3-3 3M13 15h3");
    }
    button.appendChild(svg);
  }

  function textNode(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
    return node;
  }

  /** 搜索只在当前目录的直接素材里做，不穿透子目录。 */
  function visibleItems(tree) {
    var query = state.query.toLowerCase();
    var out = [];
    for (var i = 0; i < tree.direct.length; i++) {
      var item = tree.direct[i];
      if (state.category !== "all" && item.type !== state.category) {
        continue;
      }
      if (state.favoritesOnly && !isFavorite(item.path)) continue;
      if (query) {
        var haystack = String(item.name + " " + item.type).toLowerCase();
        if (haystack.indexOf(query) < 0) continue;
      }
      out.push(item);
    }
    return out;
  }

  /* ---------- 面包屑 ---------- */
  function renderBreadcrumb() {
    var nav = byId("materialBreadcrumb");
    if (!nav) return;
    nav.textContent = "";
    var root = normPath(state.root);
    if (!root) {
      var none = document.createElement("span");
      none.className = "material-crumb current";
      none.textContent = L("materials.noRoot");
      nav.appendChild(none);
      return;
    }

    /* 首段是根目录的文件夹名（不是完整路径），完整路径放在 title 里。 */
    var segments = [{ label: baseName(root), path: root, title: root }];
    var dir = normPath(state.dir) || root;
    if (pathKey(dir) !== pathKey(root)) {
      var parts = dir.substring(root.length + 1).split("/");
      var acc = root;
      for (var i = 0; i < parts.length; i++) {
        acc = joinPath(acc, parts[i]);
        segments.push({ label: parts[i], path: acc, title: acc });
      }
    }

    /* 层级过多：中间折成 "…"，首段与末段始终可见。 */
    var shown = segments;
    if (segments.length > 4) {
      shown = [segments[0], null, segments[segments.length - 1]];
    }

    for (var j = 0; j < shown.length; j++) {
      if (j > 0) {
        nav.appendChild(textNode("span", "material-crumb-sep", "›"));
      }
      var seg = shown[j];
      if (seg === null) {
        var hidden = [];
        for (var h = 1; h < segments.length - 1; h++) hidden.push(segments[h].label);
        var dots = textNode("span", "material-crumb-ellipsis", "…");
        dots.title = hidden.join(" › ");
        nav.appendChild(dots);
        continue;
      }
      var isLast = j === shown.length - 1;
      var node;
      if (isLast) {
        /* 当前层：纯文本，不是链接，也不可点。 */
        node = document.createElement("span");
        node.className = "material-crumb current";
      } else {
        node = document.createElement("button");
        node.type = "button";
        node.className = "material-crumb";
        (function (target, button) {
          button.addEventListener("click", function () {
            state.dir = target;
            state.selectedPath = "";
            render();
          });
        })(seg.path, node);
      }
      node.textContent = seg.label;
      if (seg.title) node.title = seg.title;
      nav.appendChild(node);
    }
  }

  function renderCards(tree) {
    var grid = byId("materialGrid");
    var empty = byId("materialEmpty");
    if (!grid) return;
    pauseAll();
    grid.textContent = "";
    var items = visibleItems(tree);
    var searching = !!state.query;
    var i;
    var hasParent = isInsideFolder();
    if (hasParent) grid.appendChild(makeParentButton());
    if (!searching) {
      for (i = 0; i < tree.folders.length; i++) {
        grid.appendChild(makeFolderCard(tree.folders[i]));
      }
    }
    for (i = 0; i < items.length; i++) {
      grid.appendChild(makeCard(items[i]));
    }
    var total = (searching ? 0 : tree.folders.length) + items.length;
    grid.hidden = total === 0 && !hasParent;
    if (empty) {
      empty.hidden = total !== 0;
      if (total === 0) {
        var strong = byId("materialEmptyText") || empty.querySelector("strong");
        var folderIsEmpty = !searching &&
          tree.folders.length === 0 && tree.direct.length === 0;
        var key = folderIsEmpty ? "materials.emptyFolder" : "materials.empty";
        if (strong) {
          strong.setAttribute("data-i18n", key);
          strong.textContent = L(key);
        }
      }
    }
  }

  /** 返回控件占网格首格，但不套卡片外框或预览底色。 */
  function makeParentButton() {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "material-parent";
    button.setAttribute("data-material-parent", "true");
    button.setAttribute("aria-label", L("materials.back"));
    button.title = L("materials.backHint");

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    appendIconPath(svg, "M12 2.5 2.5 12h6v9.5h7V12h6z");
    button.appendChild(svg);

    button.addEventListener("dblclick", function (event) {
      event.preventDefault();
      event.stopPropagation();
      goUp();
    });
    button.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        goUp();
      }
    });
    return button;
  }

  /** 文件夹卡片复用 .material-card 骨架，因此天然遵循 --view-size 与网格布局。 */
  function makeFolderCard(folder) {
    var card = document.createElement("article");
    card.className = "material-card folder";
    card.setAttribute("data-path", folder.path);
    if (state.selectedPath && AEV_Prefs.pathKey(state.selectedPath) === AEV_Prefs.pathKey(folder.path)) {
      card.className += " selected";
    }
    card.title = folder.path;

    var preview = document.createElement("div");
    preview.className = "material-preview";
    var folderArt = document.createElement("div");
    folderArt.className = "material-folder-art";
    folderArt.setAttribute("aria-hidden", "true");
    folderArt.appendChild(textNode("span", "material-folder-back", ""));
    folderArt.appendChild(textNode("span", "material-folder-sheet material-folder-sheet-3", ""));
    folderArt.appendChild(textNode("span", "material-folder-sheet material-folder-sheet-2", ""));
    folderArt.appendChild(textNode("span", "material-folder-sheet material-folder-sheet-1", ""));
    folderArt.appendChild(textNode("span", "material-folder-front", ""));
    preview.appendChild(folderArt);
    card.appendChild(preview);

    var body = document.createElement("div");
    body.className = "material-card-body";
    var folderRow = document.createElement("div");
    folderRow.className = "material-folder-row";
    var folderName = textNode("span", "material-name", folder.name);
    folderName.title = folder.name;
    folderRow.appendChild(folderName);
    folderRow.appendChild(textNode(
      "span",
      "material-folder-count",
      L("materials.folderItems", [folder.count])
    ));
    body.appendChild(folderRow);
    card.appendChild(body);

    card.addEventListener("click", function () {
      selectCard(folder.path);
    });
    card.addEventListener("dblclick", function () {
      state.dir = folder.path;
      state.selectedPath = "";
      render();
    });
    return card;
  }

  function makeCard(item) {
    var card = document.createElement("article");
    card.className = "material-card " + item.type;
    card.setAttribute("data-path", item.path);
    if (state.selectedPath && AEV_Prefs.pathKey(state.selectedPath) === AEV_Prefs.pathKey(item.path)) {
      card.className += " selected";
    }
    card.title = item.path;

    var preview = document.createElement("div");
    preview.className = "material-preview";
    if (item.type === "image") {
      var image = document.createElement("img");
      image.loading = "lazy";
      image.alt = item.name;
      image.src = fileUrl(item.imageThumb || item.path);
      preview.appendChild(image);
    } else if (item.type === "video") {
      var video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.src = fileUrl(item.videoPreview || item.path);
      preview.appendChild(video);
    } else if (item.type === "audio") {
      var waveform = document.createElement("div");
      waveform.className = "material-waveform";
      var waveformCanvas = document.createElement("canvas");
      waveformCanvas.className = "material-waveform-canvas";
      waveformCanvas.width = 320;
      waveformCanvas.height = 120;
      waveformCanvas.setAttribute("aria-hidden", "true");
      waveform.appendChild(waveformCanvas);
      preview.appendChild(waveform);
      queueWaveform(item, waveformCanvas);
      var audio = document.createElement("audio");
      audio.hidden = true;
      audio.preload = "metadata";
      audio.src = fileUrl(item.path);
      card.appendChild(audio);
    } else if (item.type === "project") {
      preview.appendChild(textNode("span", "material-kind", L("materials.project")));
    } else if (item.type === "script") {
      preview.appendChild(textNode("span", "material-kind", L("materials.script")));
    } else {
      preview.appendChild(textNode("span", "material-kind", item.type));
    }
    card.appendChild(preview);
    card.appendChild(makeFavoriteButton(item.path));

    var body = document.createElement("div");
    body.className = "material-card-body";
    var fileName = String(item.name || "");
    var extensionAt = fileName.lastIndexOf(".");
    var fileStem = extensionAt > 0 ? fileName.substring(0, extensionAt) : fileName;
    var fileExtension = extensionAt > 0 ? fileName.substring(extensionAt + 1) : "";
    var fileRow = document.createElement("div");
    fileRow.className = "material-file-row";
    var stem = textNode("span", "material-file-stem", fileStem);
    stem.title = fileName;
    fileRow.appendChild(stem);
    if (fileExtension) {
      var extension = textNode("span", "material-file-ext", fileExtension.toUpperCase());
      extension.title = "." + fileExtension;
      extension.setAttribute("aria-label", "." + fileExtension);
      fileRow.appendChild(extension);
    }
    body.appendChild(fileRow);
    card.appendChild(body);
    bindMaterialCard(card, item);
    return card;
  }

  function isFavorite(path) {
    return window.AEV_Prefs && AEV_Prefs.isFavorite("materials", path);
  }

  function makeFavoriteButton(path) {
    var active = isFavorite(path);
    var button = document.createElement("button");
    button.type = "button";
    button.className = "favorite-toggle" + (active ? " active" : "");
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.setAttribute("aria-label", L(active ? "favorites.remove" : "favorites.add"));
    button.title = L(active ? "favorites.remove" : "favorites.add");
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    var star = document.createElementNS("http://www.w3.org/2000/svg", "path");
    star.setAttribute("d", "M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z");
    svg.appendChild(star);
    button.appendChild(svg);
    button.addEventListener("click", function (event) {
      event.stopPropagation();
      AEV_Prefs.toggleFavorite("materials", path);
      render();
    });
    button.addEventListener("dblclick", function (event) {
      event.stopPropagation();
    });
    return button;
  }

  function fileUrl(path) {
    var normalized = String(path || "").replace(/\\/g, "/");
    return "file:///" + encodeURI(normalized).replace(/#/g, "%23");
  }

  function waveformKey(item) {
    return pathKey(item.path) + "|" + Number(item.size || 0) + "|" +
      Number(item.modifiedAt || 0);
  }

  function drawWaveform(canvas, peaks) {
    if (!canvas || !canvas.parentNode || !AEV_AudioWaveform.draw(canvas, peaks)) return;
    canvas.parentNode.className = "material-waveform is-ready";
  }

  /** Decode one audio file at a time so a folder full of sounds cannot block the panel. */
  function queueWaveform(item, canvas) {
    var key = waveformKey(item);
    var cached = state.waveformCache[key];
    if (cached) {
      drawWaveform(canvas, cached);
      return;
    }
    if (cached === false) return;
    if (state.waveformPending[key]) {
      state.waveformPending[key].push(canvas);
      return;
    }
    state.waveformPending[key] = [canvas];
    state.waveformQueue.push({ key: key, path: item.path });
    pumpWaveformQueue();
  }

  function pumpWaveformQueue() {
    if (state.waveformBusy || !state.waveformQueue.length) return;
    var task = state.waveformQueue.shift();
    state.waveformBusy = true;

    function finish(error, peaks) {
      var valid = !error && peaks && peaks.length;
      state.waveformCache[task.key] = valid ? peaks : false;
      var canvases = state.waveformPending[task.key] || [];
      delete state.waveformPending[task.key];
      for (var i = 0; i < canvases.length; i++) {
        if (valid) drawWaveform(canvases[i], peaks);
      }
      state.waveformBusy = false;
      pumpWaveformQueue();
    }

    if (!window.AEV_AudioWaveform) {
      finish("waveform_module_unavailable");
      return;
    }
    try {
      AEV_AudioWaveform.load(task.path, 256, finish);
    } catch (e) {
      finish(String(e && e.message || e));
    }
  }

  function bindMaterialCard(card, item) {
    var media = card.querySelector("video,audio");
    card.addEventListener("click", function (event) {
      if (event.target && event.target.closest && event.target.closest(".favorite-toggle")) return;
      selectCard(item.path);
      if (!media) {
        pauseAll();
        return;
      }
      if (state.clickTimer) {
        clearTimeout(state.clickTimer);
        state.clickTimer = null;
      }
      if (event.detail > 1) return;
      state.clickTimer = setTimeout(function () {
        state.clickTimer = null;
        toggleMedia(media, item.type);
      }, 220);
    });
    card.addEventListener("dblclick", function (event) {
      if (event.target && event.target.closest && event.target.closest(".favorite-toggle")) return;
      if (state.clickTimer) {
        clearTimeout(state.clickTimer);
        state.clickTimer = null;
      }
      importItem(item);
    });
  }

  function selectCard(path) {
    state.selectedPath = path;
    var cards = document.querySelectorAll(".material-card");
    for (var i = 0; i < cards.length; i++) {
      var same = AEV_Prefs.pathKey(cards[i].getAttribute("data-path")) === AEV_Prefs.pathKey(path);
      cards[i].className = cards[i].className.replace(/\s*selected/g, "");
      if (same) cards[i].className += " selected";
    }
  }

  function toggleMedia(media, type) {
    var wasPlaying = state.activeMedia === media;
    pauseAll();
    if (wasPlaying) return;
    if (type === "video") playVideo(media);
    else if (type === "audio") playAudio(media);
  }

  function playVideo(video) {
    pauseAll();
    state.activeMedia = video;
    try { video.currentTime = 0; } catch (e) {}
    try {
      var promise = video.play();
      if (promise && promise.catch) promise.catch(function () {});
    } catch (e2) {}
    state.videoTimer = setTimeout(pauseAll, 5000);
  }

  function playAudio(audio) {
    pauseAll();
    state.activeMedia = audio;
    audio.addEventListener("ended", function () {
      if (state.activeMedia === audio) pauseAll(true);
    }, { once: true });
    clearAudioFade(audio);
    setAudioVolume(audio, 0);
    try {
      var promise = audio.play();
      if (promise && promise.catch) promise.catch(function () {});
    } catch (e) {}
    fadeAudio(audio, AUDIO_PREVIEW_VOLUME, AUDIO_FADE_IN_MS);
  }

  function importItem(item) {
    run(
      "AEV_Materials.importJson(" +
        JSON.stringify(item.path) + "," +
        JSON.stringify(item.type) + ")",
      function (text) {
      var data = parseResult(text);
      if (data && data.status === "ok") {
        setStatus(L(
          data.kind === "project" ? "materials.importedProject" : "materials.addedToComp",
          [item.name, Number(data.time) || 0]
        ), false);
      } else {
        var reason = data && data.reason ? data.reason : "unknown";
        setStatus(
          reason === "no_comp"
            ? L("materials.noComp")
            : L("materials.importFailed", [reason]),
          true
        );
      }
      }
    );
  }

  function render() {
    var tree = buildTree();
    if (resolveDir(tree.dirs)) tree = buildTree();
    renderBreadcrumb();
    renderCategories(tree);
    renderCards(tree);
  }

  function clearAudioFade(audio) {
    if (!audio) return;
    if (audio.__deFadeTimer) {
      clearInterval(audio.__deFadeTimer);
      audio.__deFadeTimer = null;
    }
    if (audio.__deStopTimer) {
      clearTimeout(audio.__deStopTimer);
      audio.__deStopTimer = null;
    }
  }

  function setAudioVolume(audio, value) {
    var next = Math.max(0, Math.min(1, Number(value) || 0));
    try { audio.volume = next; } catch (e) {}
  }

  function fadeAudio(audio, target, duration, callback) {
    clearAudioFade(audio);
    var from = Number(audio.volume);
    if (!isFinite(from)) from = 0;
    var steps = Math.max(1, Math.round(duration / AUDIO_FADE_STEP_MS));
    var current = 0;
    audio.__deFadeTimer = setInterval(function () {
      current++;
      var progress = current / steps;
      setAudioVolume(audio, from + (target - from) * progress);
      if (current < steps) return;
      clearInterval(audio.__deFadeTimer);
      audio.__deFadeTimer = null;
      setAudioVolume(audio, target);
      if (callback) callback();
    }, Math.max(1, Math.round(duration / steps)));
  }

  function stopAudio(audio, immediate) {
    clearAudioFade(audio);
    function finish() {
      try { audio.pause(); } catch (e) {}
      try { audio.currentTime = 0; } catch (e2) {}
      setAudioVolume(audio, 0);
    }
    if (immediate) finish();
    else fadeAudio(audio, 0, AUDIO_FADE_OUT_MS, finish);
  }

  function pauseAll(immediate) {
    if (state.clickTimer) {
      clearTimeout(state.clickTimer);
      state.clickTimer = null;
    }
    if (state.videoTimer) {
      clearTimeout(state.videoTimer);
      state.videoTimer = null;
    }
    var active = state.activeMedia;
    state.activeMedia = null;
    if (!active) return;
    if (!immediate && active.tagName && active.tagName.toLowerCase() === "audio") {
      stopAudio(active, false);
      return;
    }
    stopAudio(active, true);
  }

  function loadIndex() {
    run("AEV_Materials.indexJson()", function (text) {
      var data = parseResult(text);
      if (data && data.status !== "error" && data.items) {
        state.items = normalizeItems(data.items);
        state.root = normPath(data.root || "");
        state.dir = state.root;
        state.loaded = true;
      } else if (data && data.status === "error") {
        setStatus(L("materials.readFailed", [data.reason || ""]), true);
      }
      render();
    });
  }

  /** 换目录：复用 pickRoot 的逻辑，调用 AEV_Materials.pickRootJson()。 */
  function pickRoot() {
    run("AEV_Materials.pickRootJson()", function (text) {
      var data = parseResult(text);
      if (!data || data.status === "cancelled") return;
      if (data.status !== "ok") {
        setStatus(L("materials.readFailed", [data.reason || ""]), true);
        return;
      }
      state.items = normalizeItems(data.items);
      state.root = normPath(data.root || "");
      state.dir = state.root;
      state.selectedPath = "";
      state.loaded = true;
      setStatus(L("materials.scanned", [state.items.length]), false);
      render();
    });
  }

  /** 刷新：scanJson(root)；state.dir 不变，由 render() 里的 resolveDir 校验并回退。 */
  function refresh() {
    if (!state.root) {
      pickRoot();
      return;
    }
    run("AEV_Materials.scanJson(" + JSON.stringify(state.root) + ")", function (text) {
      var data = parseResult(text);
      if (!data || data.status !== "ok") {
        setStatus(L("materials.readFailed", [data && data.reason ? data.reason : ""]), true);
        return;
      }
      state.items = normalizeItems(data.items);
      state.loaded = true;
      setStatus(L("materials.scanned", [state.items.length]), false);
      render();
    });
  }

  function setStatus(text, error) {
    var el = byId("statusText");
    if (!el) return;
    el.textContent = text;
    el.style.color = error ? "var(--danger)" : "";
  }

  function bind() {
    var changeRoot = byId("btnMaterialChangeRoot");
    var refreshButton = byId("btnMaterialRefresh");
    if (changeRoot) changeRoot.addEventListener("click", pickRoot);
    if (refreshButton) refreshButton.addEventListener("click", refresh);
  }

  function enter() {
    if (!state.loaded) loadIndex();
    else render();
  }

  function leave() {
    pauseAll();
  }

  function setLanguage(lang) {
    state.lang = lang === "en" ? "en" : "zh";
    render();
  }

  /**
   * 搜索词由顶栏那一个搜索框统一驱动（原来在素材页里还有一个自己的输入框）。
   * 只改查询并重绘，不做防抖 —— 卡片数量有限，按下即筛。
   */
  function setQuery(value) {
    var next = String(value === undefined || value === null ? "" : value);
    if (next === state.query) return;
    state.query = next;
    if (state.loaded) render();
  }

  function getQuery() {
    return state.query;
  }

  document.addEventListener("DOMContentLoaded", bind);

  return {
    enter: enter,
    leave: leave,
    refresh: refresh,
    setLanguage: setLanguage,
    setQuery: setQuery,
    getQuery: getQuery,
    pauseAll: pauseAll,
    state: state
  };
})();
