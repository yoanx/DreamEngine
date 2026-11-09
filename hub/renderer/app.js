/* ============================================================
 * app.js —— 渲染进程逻辑
 *
 * 只用 window.hub（preload 暴露的白名单），不碰 Node。
 * 换壳（Tauri 等）时只需要替换 preload 那一层。
 * ============================================================ */

const $ = (id) => document.getElementById(id);
const RENDER_AE_KEY = "dreamengine.renderAePath.v1";
const PRESET_SIDEBAR_WIDTH_KEY = "dreamengine.hub.presetSidebarWidth.v1";
const PRESET_SIDEBAR_COLLAPSED_KEY = "dreamengine.hub.presetSidebarCollapsed.v1";
const EFFECT_SIDEBAR_WIDTH_KEY = "dreamengine.hub.effectSidebarWidth.v1";
const EFFECT_SIDEBAR_COLLAPSED_KEY = "dreamengine.hub.effectSidebarCollapsed.v1";
const EFFECT_GROUP_COLLAPSED_KEY = "dreamengine.hub.effectGroupCollapsed.v1";
const SIDEBAR_MIN = 150;
const SIDEBAR_MAX = 420;

const state = {
  snapshot: null,
  presets: [],
  query: "",
  view: "presets",
  renderMode: "preset",
  logKind: "preset",
  rendering: false,
  stopRequested: false,
  pluginEffectRendering: false,
  pluginEffectStopRequested: false,
  pluginCatalog: null,
  pluginCatalogScanning: false,
  pluginEffectSelection: new Map(),
  effectPicker: { query: "", plugin: "", hideRendered: true, force: false },
  effects: [],
  effectData: null,
  effectQuery: "",
  effectCategory: "all",
  effectPlugin: "all",
  effectFavorites: new Set(),
  effectFavoritesOnly: false,
  effectSelection: new Map(),
  effectGroupCollapsed: {},
  effectHoverStop: null,
  presetSelection: new Map(),
  pollTimer: null,
  pluginEffectPollTimer: null,
  logTimer: null,
  presetHoldTimer: null,
  presetHoverStop: null,
  presetDeletePath: "",
  presetDeleteName: "",
  presetRenamePath: "",
  presetOrganizer: { categories: [], assignments: {}, favorites: {} },
  presetCatalog: null,
  presetSourceFilter: "all",
  presetSyncing: false,
  presetCategory: "all",
  presetFavoritesOnly: false,
  categoryEditorMode: "create",
  categoryEditingId: "",
};

/* ---------- 工具 ---------- */

function toFileUrl(p) {
  if (!p) return "";
  const s = String(p).replace(/\\/g, "/");
  return "file:///" + encodeURI(s).replace(/#/g, "%23");
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function setStatus(text, isError) {
  const el = $("statusText");
  el.textContent = text;
  el.style.color = isError ? "var(--danger)" : "";
}

function pathKey(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

/* ---------- 分类栏：拖动宽度 / 收起展开（预设库、效果库共用） ---------- */

function createSidebarController(config) {
  const ids = config || {};
  let width = 200;
  let collapsed = false;

  function clampWidth(value) {
    const number = Number(value) || 200;
    return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(number)));
  }

  function readPrefs() {
    try {
      const storedWidth = parseInt(localStorage.getItem(ids.widthKey), 10);
      if (storedWidth) width = clampWidth(storedWidth);
      collapsed = localStorage.getItem(ids.collapsedKey) === "1";
    } catch {
      /* localStorage 不可用时使用默认值 */
    }
  }

  function apply() {
    const layout = $(ids.layoutId);
    const sidebar = $(ids.sidebarId);
    const handle = $(ids.resizerId);
    const expand = $(ids.expandId);
    if (!layout || !sidebar || !handle || !expand) return;
    layout.classList.toggle("sidebar-collapsed", collapsed);
    sidebar.style.width = collapsed ? "0px" : width + "px";
    handle.setAttribute("aria-valuenow", collapsed ? "0" : String(width));
    handle.tabIndex = collapsed ? -1 : 0;
    expand.hidden = !collapsed;
  }

  function persist() {
    try {
      localStorage.setItem(ids.widthKey, String(width));
      localStorage.setItem(ids.collapsedKey, collapsed ? "1" : "0");
    } catch {
      /* 持久化失败不影响本次使用 */
    }
  }

  function setCollapsed(next) {
    collapsed = !!next;
    apply();
    persist();
  }

  function init() {
    readPrefs();
    apply();

    const handle = $(ids.resizerId);
    const collapse = $(ids.collapseId);
    const expand = $(ids.expandId);
    if (collapse) collapse.addEventListener("click", () => setCollapsed(true));
    if (expand) expand.addEventListener("click", () => setCollapsed(false));
    if (!handle) return;

    let drag = null;
    const finishDrag = () => {
      if (!drag) return;
      drag = null;
      document.body.classList.remove("sidebar-resizing");
      persist();
    };
    handle.addEventListener("pointerdown", (event) => {
      if (collapsed || (event.button !== undefined && event.button !== 0)) return;
      drag = { startX: event.clientX, startWidth: width };
      document.body.classList.add("sidebar-resizing");
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        /* 某些环境不支持 pointer capture */
      }
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      width = clampWidth(drag.startWidth + (event.clientX - drag.startX));
      apply();
    });
    handle.addEventListener("pointerup", finishDrag);
    handle.addEventListener("pointercancel", finishDrag);
    handle.addEventListener("lostpointercapture", finishDrag);
    handle.addEventListener("dblclick", () => setCollapsed(!collapsed));
    handle.addEventListener("keydown", (event) => {
      if (collapsed) return;
      const step = event.shiftKey ? 32 : 8;
      if (event.key === "ArrowLeft") {
        width = clampWidth(width - step);
      } else if (event.key === "ArrowRight") {
        width = clampWidth(width + step);
      } else if (event.key === "Home") {
        width = SIDEBAR_MIN;
      } else if (event.key === "End") {
        width = SIDEBAR_MAX;
      } else if (event.key === "Enter" || event.key === " ") {
        setCollapsed(true);
        return;
      } else {
        return;
      }
      event.preventDefault();
      apply();
      persist();
    });
  }

  return { init, apply, setCollapsed };
}

/* 预设库沿用原来的 localStorage 键，效果库用自己的一组键 */
const presetSidebar = createSidebarController({
  layoutId: "presetLayout",
  sidebarId: "presetSidebar",
  resizerId: "presetSidebarResizer",
  collapseId: "btnCollapseSidebar",
  expandId: "btnExpandSidebar",
  widthKey: PRESET_SIDEBAR_WIDTH_KEY,
  collapsedKey: PRESET_SIDEBAR_COLLAPSED_KEY,
});

const effectSidebar = createSidebarController({
  layoutId: "effectLayout",
  sidebarId: "effectSidebar",
  resizerId: "effectSidebarResizer",
  collapseId: "btnEffectCollapseSidebar",
  expandId: "btnEffectExpandSidebar",
  widthKey: EFFECT_SIDEBAR_WIDTH_KEY,
  collapsedKey: EFFECT_SIDEBAR_COLLAPSED_KEY,
});

/* 预设渲染、插件效果渲染、插件目录扫描共用同一套 AE 独占资源 */
function anyJobBusy() {
  return state.rendering || state.pluginEffectRendering || state.pluginCatalogScanning;
}

function hubHas(name) {
  return !!(window.hub && typeof window.hub[name] === "function");
}

/* ---------- 页签 ---------- */

function setView(name) {
  const pluginAlias = name === "pluginEffects";
  const target = pluginAlias ? "render" : name;
  state.view = target;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === target);
  }
  $("viewPresets").hidden = target !== "presets";
  $("viewEffects").hidden = target !== "effects";
  $("viewRender").hidden = target !== "render";
  $("viewSettings").hidden = target !== "settings";

  if (target === "effects") loadEffects();
  else if (state.effectHoverStop) state.effectHoverStop();

  if (target === "render") {
    if (window.PreviewFlow && typeof window.PreviewFlow.show === "function") {
      window.PreviewFlow.show();
    }
    refreshAeState();
  } else if (!$("renderLogDialog").hidden) {
    closeRenderLog();
  }
  if (target !== "presets") closePresetDelete();
  if (target !== "presets") closePresetRename();
  if (target !== "presets") hideCategoryMenu();
  if (target !== "presets" && state.presetHoverStop) state.presetHoverStop();
}

/* ---------- 预设库 ---------- */

function categories() {
  return state.presetOrganizer.categories || [];
}

function categoryFor(target) {
  return String((state.presetOrganizer.assignments || {})[pathKey(target)] || "");
}

function categoryLabel(target) {
  const id = categoryFor(target);
  const hit = categories().find((row) => row.id === id);
  return hit ? hit.name : "";
}

function isPresetFavorite(target) {
  return !!(state.presetOrganizer.favorites || {})[pathKey(target)];
}

function renderCategories() {
  const list = $("categoryList");
  if (!list) return;
  const counts = { favorite: 0, all: state.presets.length, uncategorized: 0 };
  const aeCounts = {};
  for (const item of state.presets) {
    if (isPresetFavorite(item.path)) counts.favorite++;
    if (item.external) {
      const source = item.source || "AE 内置";
      aeCounts[source] = (aeCounts[source] || 0) + 1;
      continue;
    }
    const id = categoryFor(item.path);
    if (!id) counts.uncategorized++;
    else counts[id] = (counts[id] || 0) + 1;
  }
  list.textContent = "";
  list.appendChild(categoryRow("__favorites__", "收藏", counts.favorite));
  list.appendChild(categoryRow("all", "全部预设", counts.all));
  list.appendChild(categoryRow("__uncategorized__", "未分类", counts.uncategorized));
  if (categories().length) {
    list.appendChild(sidebarGroupTitle("我的分类"));
  }
  for (const category of categories()) {
    const row = categoryRow(category.id, category.name, counts[category.id] || 0);
    row.querySelector("button").addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openCategoryAdminMenu(category, event.clientX, event.clientY);
    });
    list.appendChild(row);
  }
  const aeSources = Object.keys(aeCounts).sort(
    (a, b) => aeCounts[b] - aeCounts[a] || a.localeCompare(b, "zh"),
  );
  if (aeSources.length) {
    list.appendChild(sidebarGroupTitle("AE 预设分类"));
    for (const source of aeSources) {
      list.appendChild(categoryRow("ae:" + source, source, aeCounts[source]));
    }
  }
}

function sidebarGroupTitle(label) {
  const li = document.createElement("li");
  li.className = "sidebar-group-title";
  li.textContent = label;
  return li;
}

function syncPresetSourceFilter() {
  const select = $("presetSourceFilter");
  if (select) select.value = state.presetSourceFilter;
}

/* 工具栏的「仅显示已收藏预设」是独立开关（与侧栏收藏分类选择分开） */
function syncPresetFavoritesOnlyButton() {
  const button = $("btnPresetFavoritesOnly");
  if (!button) return;
  button.setAttribute("aria-pressed", state.presetFavoritesOnly ? "true" : "false");
}

function categoryRow(id, label, count) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  const active = state.presetCategory === id;
  button.className =
    "category-item" + (id === "__favorites__" ? " favorite-category" : "") + (active ? " active" : "");
  const text = document.createElement("span");
  text.className = "category-label";
  text.textContent = label;
  const badge = document.createElement("span");
  badge.className = "category-count";
  badge.textContent = String(count);
  button.appendChild(text);
  button.appendChild(badge);
  button.addEventListener("click", () => {
    state.presetCategory = id;
    if (id === "__favorites__") {
      /* 收藏是「分类选择」：显示全部收藏，清掉搜索并重置来源 */
      state.presetSourceFilter = "all";
      state.query = "";
      const search = $("search");
      if (search) search.value = "";
    } else if (id.startsWith("ae:")) {
      state.presetSourceFilter = "external";
    } else if (id === "all") {
      state.presetSourceFilter = "all";
    } else {
      state.presetSourceFilter = "mine";
    }
    syncPresetSourceFilter();
    renderPresets();
  });
  li.appendChild(button);
  return li;
}

function bindFavoriteButton(thumb, item) {
  const active = isPresetFavorite(item.path);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-favorite-toggle" + (active ? " active" : "");
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.title = active ? "取消收藏" : "收藏";
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/></svg>';
  button.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    cancelPresetHold();
  });
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await togglePresetFavorite(item);
  });
  button.addEventListener("dblclick", (event) => event.stopPropagation());
  thumb.appendChild(button);
}

function frameUrl(item, index) {
  if (!item.framePattern) return "";
  return toFileUrl(item.framePattern.replace("%04d", String(index).padStart(4, "0")));
}

function bindPresetHoverPreview(card, img, item) {
  if (!item.animated || item.frames <= 1 || !item.framePattern) return;
  const fps = Math.max(1, Number(item.fps) || 6);
  const delay = Math.max(40, Math.round(1000 / fps));
  const frames = [];
  let preloaded = false;
  let timer = null;
  let index = 0;

  function preload() {
    if (preloaded) return;
    preloaded = true;
    for (let i = 0; i < item.frames; i++) {
      const node = new Image();
      node.src = frameUrl(item, i);
      frames.push(node);
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    index = 0;
    img.src = toFileUrl(item.thumb);
    if (state.presetHoverStop === stop) state.presetHoverStop = null;
  }

  card.addEventListener("mouseenter", () => {
    if (state.presetHoverStop && state.presetHoverStop !== stop) state.presetHoverStop();
    state.presetHoverStop = stop;
    preload();
    if (timer) clearInterval(timer);
    index = 0;
    img.src = frameUrl(item, 0) || toFileUrl(item.thumb);
    timer = setInterval(() => {
      index = (index + 1) % item.frames;
      img.src = frameUrl(item, index) || toFileUrl(item.thumb);
    }, delay);
  });
  card.addEventListener("mouseleave", stop);
}

function bindCategoryButton(thumb, item) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-category-toggle";
  button.title = "移动到分类";
  button.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v10H3z"/></svg>';
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const rect = button.getBoundingClientRect();
    openCategoryMenu(item, rect.left, rect.bottom + 4);
  });
  button.addEventListener("dblclick", (event) => event.stopPropagation());
  thumb.appendChild(button);
}

function hideCategoryMenu() {
  $("categoryMenu").hidden = true;
}

function showCategoryMenu(x, y) {
  const menu = $("categoryMenu");
  menu.hidden = false;
  const width = menu.offsetWidth || 190;
  const height = menu.offsetHeight || 0;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - width - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - height - 8)) + "px";
}

function menuTitle(text) {
  const node = document.createElement("div");
  node.className = "preset-category-menu-title";
  node.textContent = text;
  return node;
}

function menuButton(label, active, danger, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = (active ? "active" : "") + (danger ? " danger" : "");
  button.textContent = label;
  button.addEventListener("click", () => {
    hideCategoryMenu();
    action();
  });
  return button;
}

function openCategoryMenu(item, x, y) {
  const menu = $("categoryMenu");
  menu.textContent = "";
  menu.appendChild(menuTitle("移动到分类"));
  const current = categoryFor(item.path);
  menu.appendChild(menuButton("未分类", !current, false, () => assignCategory(item, "")));
  for (const category of categories()) {
    menu.appendChild(menuButton(category.name, current === category.id, false, () =>
      assignCategory(item, category.id),
    ));
  }
  showCategoryMenu(x, y);
}

function openPresetMenu(item, x, y) {
  const menu = $("categoryMenu");
  menu.textContent = "";
  menu.appendChild(menuTitle(item.name));
  const favorite = isPresetFavorite(item.path);
  if (!item.external) {
    menu.appendChild(menuButton("重命名", false, false, () => openPresetRename(item)));
  }
  menu.appendChild(menuButton(favorite ? "取消收藏" : "收藏", false, false, () =>
    togglePresetFavorite(item),
  ));
  if (item.rendered) {
    menu.appendChild(menuButton("取消渲染", false, false, () => clearPresetRender(item)));
  }
  menu.appendChild(menuButton("预览渲染此条", false, false, () => renderSinglePreset(item)));
  if (item.external) {
    menu.appendChild(
      menuButton("打开所在文件夹", false, false, () => window.hub.reveal(item.path)),
    );
  } else {
    menu.appendChild(menuButton("删除预设", false, true, () => openPresetDelete(item)));

    const separator = document.createElement("div");
    separator.className = "preset-category-menu-separator";
    menu.appendChild(separator);
    menu.appendChild(menuTitle("移动到分类"));
    const current = categoryFor(item.path);
    menu.appendChild(menuButton("未分类", !current, false, () => assignCategory(item, "")));
    for (const category of categories()) {
      menu.appendChild(menuButton(category.name, current === category.id, false, () =>
        assignCategory(item, category.id),
      ));
    }
  }
  showCategoryMenu(x, y);
}

function openCategoryAdminMenu(category, x, y) {
  const menu = $("categoryMenu");
  menu.textContent = "";
  menu.appendChild(menuTitle(category.name));
  menu.appendChild(menuButton("重命名", false, false, () =>
    openCategoryEditor("rename", category),
  ));
  menu.appendChild(menuButton("删除", false, true, () => deleteCategory(category)));
  showCategoryMenu(x, y);
}

function openCategoryEditor(mode, category) {
  state.categoryEditorMode = mode;
  state.categoryEditingId = category ? category.id : "";
  $("categoryEditor").hidden = false;
  $("categoryName").value = category ? category.name : "";
  $("categoryName").focus();
}

function closeCategoryEditor() {
  $("categoryEditor").hidden = true;
  $("categoryName").value = "";
  state.categoryEditingId = "";
}

async function saveCategory(event) {
  event.preventDefault();
  const name = $("categoryName").value.trim();
  if (!name) return;
  const result =
    state.categoryEditorMode === "rename"
      ? await window.hub.renamePresetCategory(state.categoryEditingId, name)
      : await window.hub.createPresetCategory(name);
  if (!result.ok) {
    setStatus("分类名称已存在", true);
    return;
  }
  state.presetOrganizer = result.doc;
  closeCategoryEditor();
  setStatus(state.categoryEditorMode === "rename" ? "分类已重命名" : "已新建分类");
  renderPresets();
}

async function assignCategory(item, id) {
  const result = await window.hub.assignPresetCategory(item.path, id);
  if (!result.ok) return;
  state.presetOrganizer = result.doc;
  renderPresets();
}

async function togglePresetFavorite(item) {
  const result = await window.hub.togglePresetFavorite(item.path);
  if (!result.ok) return;
  state.presetOrganizer = result.doc;
  setStatus(result.favorite ? `已收藏「${item.name}」` : `已取消收藏「${item.name}」`);
  renderPresets();
}

async function clearPresetRender(item) {
  if (state.rendering) {
    setStatus("请先停止当前渲染任务，再清空预设预览", true);
    return;
  }
  const result = await window.hub.clearPresetRender(item.path);
  if (!result.ok) return;
  await loadPresets();
  setStatus(`已清空「${item.name}」的预览，下次批渲会重新加入`);
}

async function deleteCategory(category) {
  const result = await window.hub.deletePresetCategory(category.id);
  if (!result.ok) return;
  state.presetOrganizer = result.doc;
  if (state.presetCategory === category.id) state.presetCategory = "all";
  setStatus(`已删除分类「${category.name}」`);
  renderPresets();
}

async function loadPresetCategories() {
  state.presetOrganizer = await window.hub.loadPresetCategories();
}

function openPresetRename(item) {
  state.presetRenamePath = item.path;
  $("presetRenameDialog").hidden = false;
  $("presetRenameInput").value = item.name;
  $("presetRenameInput").focus();
  $("presetRenameInput").select();
}

function closePresetRename() {
  state.presetRenamePath = "";
  $("presetRenameDialog").hidden = true;
  $("presetRenameInput").value = "";
}

async function savePresetRename(event) {
  event.preventDefault();
  const target = state.presetRenamePath;
  const name = $("presetRenameInput").value.trim();
  if (!target || !name) return;
  const result = await window.hub.renamePreset(target, name);
  if (!result.ok) {
    const messages = {
      invalid_name: "文件名包含不允许的字符",
      name_exists: "同名预设已经存在",
      outside_library: "只能重命名预设库内的文件",
    };
    setStatus(messages[result.reason] || "重命名失败：" + (result.reason || "未知原因"), true);
    return;
  }
  closePresetRename();
  await loadPresetCategories();
  await loadPresets();
  setStatus(`已重命名为「${result.name}」`);
}

function visiblePresets() {
  const query = state.query.trim().toLowerCase();
  return state.presets.filter((item) => {
    if (state.presetSourceFilter === "mine" && item.external) return false;
    if (state.presetSourceFilter === "external" && !item.external) return false;
    if (query) {
      const haystack = [item.name, item.fileName, item.source, item.path]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (state.presetFavoritesOnly && !isPresetFavorite(item.path)) return false;
    const cat = categoryFor(item.path);
    if (state.presetCategory === "__favorites__") {
      return isPresetFavorite(item.path);
    }
    if (state.presetCategory === "__uncategorized__") {
      return !item.external && !cat;
    }
    if (state.presetCategory.startsWith("ae:")) {
      return item.external && (item.source || "AE 内置") === state.presetCategory.slice(3);
    }
    if (state.presetCategory !== "all") {
      return !item.external && cat === state.presetCategory;
    }
    return true;
  });
}

function renderPresets() {
  const grid = $("grid");
  if (state.presetHoverStop) state.presetHoverStop();
  const items = visiblePresets();

  grid.textContent = "";
  renderCategories();
  syncPresetFavoritesOnlyButton();

  const empty = $("emptyPresets");
  empty.hidden = items.length > 0;
  grid.hidden = items.length === 0;

  for (const item of items) {
    const card = document.createElement("div");
    card.className =
      "card" + (item.external ? " external" : "") + (isPresetSelected(item.path) ? " selected" : "");
    card.dataset.path = item.path;

    const thumb = document.createElement("div");
    thumb.className = "card-thumb";

    if (item.rendered && item.thumb) {
      const img = document.createElement("img");
      img.src = toFileUrl(item.thumb);
      img.alt = item.name;
      img.loading = "lazy";
      thumb.appendChild(img);
      bindPresetHoverPreview(card, img, item);
      if (!item.animated || item.frames <= 1) {
        const dot = document.createElement("span");
        dot.className = "card-static-dot";
        dot.title = "静止帧";
        thumb.appendChild(dot);
      }
    } else {
      const ph = document.createElement("div");
      ph.className = "placeholder";
      ph.textContent = item.external ? "AE 预设 · 待渲染" : "待渲染";
      thumb.appendChild(ph);
    }
    bindPresetSelectCheckbox(thumb, item);
    bindFavoriteButton(thumb, item);
    if (!item.external) bindCategoryButton(thumb, item);

    const body = document.createElement("div");
    body.className = "card-body";

    const titleRow = document.createElement("div");
    titleRow.className = "card-title-row";
    const name = document.createElement("div");
    name.className = "card-name";
    name.textContent = item.name;
    name.title = item.name;

    const size = document.createElement("span");
    size.className = "card-size";
    size.textContent = formatSize(item.size);

    const category = document.createElement("div");
    category.className = "card-category";
    category.textContent = item.external
      ? `AE ${state.presetCatalog && state.presetCatalog.aeMajor ? state.presetCatalog.aeMajor : ""} · ${item.source || "外部预设"}`
      : categoryLabel(item.path) || "未分类";

    titleRow.appendChild(name);
    titleRow.appendChild(size);
    body.appendChild(titleRow);
    body.appendChild(category);
    card.appendChild(thumb);
    card.appendChild(body);
    if (!item.external) bindPresetLongPress(card, item);
    card.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openPresetMenu(item, event.clientX, event.clientY);
    });
    grid.appendChild(card);
  }

  $("tabPresetCount").textContent = String(state.presets.length);
  updatePresetSelectionUI();
}

function isPresetSelected(target) {
  return state.presetSelection.has(pathKey(target));
}

function setPresetSelected(item, selected) {
  const key = pathKey(item.path);
  if (selected) state.presetSelection.set(key, item.path);
  else state.presetSelection.delete(key);
  updatePresetSelectionUI();
  setStatus(
    state.presetSelection.size
      ? `已选择 ${state.presetSelection.size} 个预设`
      : "已清空预设选择",
  );
}

function bindPresetSelectCheckbox(thumb, item) {
  const label = document.createElement("label");
  label.className = "card-select";
  label.title = "选择这个预设用于渲染";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = isPresetSelected(item.path);
  box.setAttribute("aria-label", "选择 " + item.name);
  label.appendChild(box);

  const swallow = (event) => {
    event.stopPropagation();
    cancelPresetHold();
  };
  label.addEventListener("pointerdown", swallow);
  label.addEventListener("click", swallow);
  label.addEventListener("dblclick", (event) => event.stopPropagation());
  box.addEventListener("change", () => setPresetSelected(item, box.checked));
  thumb.appendChild(label);
}

function updatePresetSelectionUI() {
  const count = state.presetSelection.size;
  const renderBtn = $("btnRenderSelected");
  renderBtn.textContent = `预览渲染 (${count})`;
  renderBtn.disabled = count === 0 || anyJobBusy();
  $("btnClearSelection").disabled = count === 0;

  for (const card of document.querySelectorAll("#grid .card")) {
    const selected = state.presetSelection.has(pathKey(card.dataset.path || ""));
    card.classList.toggle("selected", selected);
    const box = card.querySelector(".card-select input");
    if (box && box.checked !== selected) box.checked = selected;
  }

  const rendered = state.presets.filter((p) => p.rendered).length;
  const mine = state.presets.filter((p) => !p.external).length;
  const external = state.presets.length - mine;
  const parts = [];
  if (state.presets.length) {
    parts.push(`${mine} 个我的预设`);
    if (external) parts.push(`${external} 个 AE 预设`);
    parts.push(`已生成 ${rendered} 个预览`);
  }
  if (count) parts.push(`已选 ${count} 个`);
  $("presetHint").textContent = parts.join(" · ");
}

function selectUnrenderedPresets() {
  const candidates = visiblePresets().filter((item) => !item.rendered);
  if (!candidates.length) {
    setStatus("当前筛选下没有未渲染的预设", true);
    return;
  }
  for (const item of candidates) {
    state.presetSelection.set(pathKey(item.path), item.path);
  }
  updatePresetSelectionUI();
  setStatus(`已选择 ${candidates.length} 个未渲染预设`);
}

function clearPresetSelection() {
  if (!state.presetSelection.size) return;
  state.presetSelection.clear();
  updatePresetSelectionUI();
  setStatus("已清空预设选择");
}

function prunePresetSelection() {
  const alive = new Set(state.presets.map((item) => pathKey(item.path)));
  for (const key of [...state.presetSelection.keys()]) {
    if (!alive.has(key)) state.presetSelection.delete(key);
  }
}

/* ---------- 预览渲染：库 → 流程的交接 ---------- */

/*
 * 把库里的选择「种入」运行计划，然后跳到流程的第 3 步（确认渲染配置）。
 * 库里的勾选不动（Q2：种入是拷贝，不是搬走）。
 */
function handoffToPreview(kind, payload) {
  if (anyJobBusy()) {
    setStatus("已有渲染任务在运行，请先等待结束或停止", true);
    return false;
  }
  if (!window.PreviewFlow || typeof window.PreviewFlow.enterFromLibrary !== "function") {
    setStatus("预览渲染流程尚未加载（renderer/flow.js）", true);
    return false;
  }
  window.PreviewFlow.enterFromLibrary(kind, payload || {});
  return true;
}

/* 效果库条目 → 运行计划条目 */
function effectPlanItem(item) {
  let status = "excluded";
  if (item.status === "blacklisted") status = "blacklisted";
  else if (item.generated) status = "rendered";
  else if (item.renderable) status = "pending";
  const reason =
    item.status === "blacklisted" ? String(item.reason || "黑名单") : String(item.reason || "");
  return {
    key: String(item.matchName || ""),
    name: effectDisplayName(item),
    meta: [item.plugin || "", item.category || ""].filter(Boolean).join(" · "),
    status,
    reason,
    matchName: String(item.matchName || ""),
    plugin: String(item.plugin || ""),
    category: String(item.category || ""),
  };
}

async function renderSelectedPresets() {
  const paths = [...state.presetSelection.values()];
  if (!paths.length) return;
  const byKey = new Map(state.presets.map((item) => [pathKey(item.path), item]));
  const items = paths.map((presetPath) => {
    const item = byKey.get(pathKey(presetPath)) || { path: presetPath };
    return {
      key: presetPath,
      name: item.name || presetPath.split(/[\\/]/).pop() || presetPath,
      meta: [item.external ? "AE 预设" : "我的预设", item.rendered ? "已生成" : "未生成"].join(" · "),
      status: item.rendered ? "rendered" : "pending",
      presetPath,
    };
  });
  handoffToPreview("preset", { items, entry: { view: "presets" } });
}

async function loadPresets(options = {}) {
  if (!options.skipSync && hubHas("syncAePresets")) {
    const ae = (state.snapshot && state.snapshot.catalogMeta && state.snapshot.catalogMeta.aeExe) || "";
    try {
      const synced = await window.hub.syncAePresets({ ae, force: !!options.force });
      if (synced && synced.ok) state.presetCatalog = synced;
    } catch {
      /* 同步失败不阻塞预设库读取 */
    }
  }
  const data = await window.hub.listPresets();
  state.presets = data.items || [];
  prunePresetSelection();
  renderPresets();
  updatePresetSourceOptions();
}

function updatePresetSourceOptions() {
  const select = $("presetSourceFilter");
  if (!select) return;
  const external = state.presets.filter((item) => item.external).length;
  for (const option of select.options) {
    if (option.value === "external") {
      option.textContent = external ? `AE 预设 (${external})` : "AE 预设";
    }
  }
}

async function syncAePresets(force) {
  if (state.presetSyncing) return;
  if (!hubHas("syncAePresets")) {
    setStatus("主进程尚未提供 AE 预设同步接口", true);
    return;
  }
  state.presetSyncing = true;
  $("btnSyncAePresets").disabled = true;
  setStatus("正在同步 AE 预设（只建索引，不复制文件）…");
  try {
    const ae = (state.snapshot && state.snapshot.catalogMeta && state.snapshot.catalogMeta.aeExe) || "";
    const result = await window.hub.syncAePresets({ ae, force: !!force });
    if (!result || !result.ok) {
      const reason = (result && result.reason) || "";
      setStatus(
        reason === "no_ae" ? "没有找到可用的 After Effects" : "同步 AE 预设失败：" + reason,
        true,
      );
      return;
    }
    await loadPresets({ skipSync: true });
    const suffix = result.cached ? "（缓存）" : "";
    setStatus(`已同步 ${result.count} 个 AE ${result.aeMajor || ""} 预设${suffix}`);
  } finally {
    state.presetSyncing = false;
    $("btnSyncAePresets").disabled = false;
  }
}

function bindPresetLongPress(card, item) {
  if (item.external) return;
  card.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    cancelPresetHold();
    state.presetHoldTimer = setTimeout(() => {
      state.presetHoldTimer = null;
      openPresetDelete(item);
    }, 650);
  });
  card.addEventListener("pointerup", cancelPresetHold);
  card.addEventListener("pointerleave", cancelPresetHold);
  card.addEventListener("pointercancel", cancelPresetHold);
}

function cancelPresetHold() {
  if (!state.presetHoldTimer) return;
  clearTimeout(state.presetHoldTimer);
  state.presetHoldTimer = null;
}

function openPresetDelete(item) {
  if (item.external) {
    setStatus("AE 外部预设不能从预设库删除，请到 AE 预设目录中管理", true);
    return;
  }
  state.presetDeletePath = item.path;
  state.presetDeleteName = item.name;
  $("presetDeleteText").textContent =
    `确定删除预设「${item.name}」？对应的 .ffx 文件会从预设库中移除。`;
  const confirm = $("presetDeleteConfirm");
  confirm.disabled = false;
  $("presetDeleteDialog").hidden = false;
}

function closePresetDelete() {
  cancelPresetHold();
  state.presetDeletePath = "";
  state.presetDeleteName = "";
  $("presetDeleteDialog").hidden = true;
}

async function confirmPresetDelete() {
  const target = state.presetDeletePath;
  const name = state.presetDeleteName;
  if (!target) return;
  const confirm = $("presetDeleteConfirm");
  confirm.disabled = true;
  const result = await window.hub.deletePreset(target);
  if (!result || !result.ok) {
    confirm.disabled = false;
    setStatus("删除预设失败：" + ((result && result.reason) || "未知原因"), true);
    return;
  }
  closePresetDelete();
  setStatus(`已删除预设「${name}」`);
  await loadPresets();
}

async function finishAddPresets(result) {
  const imported = result.imported || [];
  const skipped = result.skipped || [];
  if (imported.length) {
    setStatus(`已添加 ${imported.length} 个预设`);
    await loadPresets();
  } else if (skipped.length) {
    setStatus("没有添加任何文件（只接受 .ffx）", true);
  }
}

async function addPresets() {
  await finishAddPresets(await window.hub.pickPresets());
}

async function addDroppedPresets(files) {
  const paths = [];
  for (const file of files) {
    try {
      const path = window.hub.getPathForFile(file);
      if (path) paths.push(path);
    } catch {
      /* 非文件拖拽不进入导入流程 */
    }
  }
  if (!paths.length) {
    setStatus("没有读取到可添加的文件", true);
    return;
  }
  await finishAddPresets(await window.hub.importPaths(paths));
}

/* ---------- 效果库 ---------- */

/* 效果库只读展示 AE 扫描结果：分类栏按插件分组（内置统一显示为「AE 内置」），
 * 不支持新建/重命名/右键菜单，分类会跟着「同步 AE 分类」自动更新。 */
const EFFECT_GROUP_BUILTIN = "AE 内置";
const EFFECT_GROUP_FALLBACK = "其它插件";

function effectGroupLabel(item) {
  if (!item || item.source === "builtin") return EFFECT_GROUP_BUILTIN;
  return String(item.plugin || EFFECT_GROUP_FALLBACK);
}

function effectGroupFromKey(key) {
  return String(key || "").split("\u0000")[0];
}

function effectCategoryKey(item) {
  return String((item && item.category) || "");
}

function effectCategoryLabel(item) {
  return effectCategoryKey(item) || "未分类";
}

/* hasPreview 由数据层给出；老数据没有该字段时退回看 framePattern */
function effectHasPreview(item) {
  if (item && typeof item.hasPreview === "boolean") return item.hasPreview;
  return !!(item && item.framePattern);
}

function effectStatusLabel(item) {
  if (item && item.status === "pending") return "待渲染";
  if (item && item.status === "blacklisted") return "已跳过";
  return "暂无预览";
}

/* ---------- 效果库：收藏 / 选择 ---------- */

function effectIsFavorite(matchName) {
  return state.effectFavorites.has(String(matchName || ""));
}

function applyEffectFavorites(list) {
  state.effectFavorites = new Set();
  for (const name of list || []) {
    const key = String(name || "");
    if (key) state.effectFavorites.add(key);
  }
}

/* 就地更新星标状态，避免收藏一次就重建 1000+ 张卡片 */
function updateEffectFavoriteButtons() {
  const grid = $("effectGrid");
  if (!grid) return;
  for (const card of grid.children) {
    const matchName = String((card.dataset && card.dataset.matchName) || "");
    const active = effectIsFavorite(matchName);
    const thumb = card.children[0];
    if (!thumb) continue;
    for (const child of thumb.children) {
      if (!String(child.className || "").includes("card-favorite-toggle")) continue;
      child.classList.toggle("active", active);
      child.setAttribute("aria-pressed", active ? "true" : "false");
      child.title = active ? "取消收藏" : "收藏";
    }
  }
}

function effectIsSelected(matchName) {
  return state.effectSelection.has(String(matchName || ""));
}

function effectSelectionBox(card) {
  const thumb = card && card.children && card.children[0];
  if (!thumb) return null;
  for (const child of thumb.children) {
    if (!String(child.className || "").includes("card-select")) continue;
    const box = child.children[0];
    if (box && box.type === "checkbox") return box;
  }
  return null;
}

function updateEffectSelectionUI() {
  const count = state.effectSelection.size;
  const renderBtn = $("btnEffectRenderSelected");
  if (renderBtn) {
    renderBtn.textContent = `预览渲染 (${count})`;
    renderBtn.disabled = count === 0 || anyJobBusy();
  }
  const clearBtn = $("btnEffectClearSelection");
  if (clearBtn) clearBtn.disabled = count === 0;

  const grid = $("effectGrid");
  if (!grid) return;
  for (const card of grid.children) {
    const matchName = String((card.dataset && card.dataset.matchName) || "");
    const selected = effectIsSelected(matchName);
    card.classList.toggle("selected", selected);
    const box = effectSelectionBox(card);
    if (box && box.checked !== selected) box.checked = selected;
  }
}

/* 数据刷新后丢掉已经不存在的选择项，并换成最新的条目对象 */
function pruneEffectSelection() {
  const alive = new Map();
  for (const item of state.effects) {
    if (item.renderable) alive.set(String(item.matchName || ""), item);
  }
  for (const key of [...state.effectSelection.keys()]) {
    if (!alive.has(key)) state.effectSelection.delete(key);
    else state.effectSelection.set(key, alive.get(key));
  }
}

/* 来源分组顺序：AE 内置第一，其它插件按名称排，「其它插件」最后 */
function compareEffectGroupLabels(a, b) {
  if (a === EFFECT_GROUP_BUILTIN) return -1;
  if (b === EFFECT_GROUP_BUILTIN) return 1;
  if (a === EFFECT_GROUP_FALLBACK) return 1;
  if (b === EFFECT_GROUP_FALLBACK) return -1;
  return a.localeCompare(b, "zh-CN");
}

/* 按 items 原顺序分组：组内分类按首次出现顺序，组间顺序再按来源排序 */
function effectGroups() {
  const groups = [];
  const byLabel = new Map();
  for (const item of state.effects) {
    const label = effectGroupLabel(item);
    let group = byLabel.get(label);
    if (!group) {
      group = { label, items: [], categories: [], categoryMap: new Map() };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.items.push(item);
    const category = effectCategoryKey(item);
    if (!category) continue;
    let row = group.categoryMap.get(category);
    if (!row) {
      row = { category, count: 0 };
      group.categoryMap.set(category, row);
      group.categories.push(row);
    }
    row.count++;
  }
  groups.sort((a, b) => compareEffectGroupLabels(a.label, b.label));
  return groups;
}

function visibleEffects() {
  const query = state.effectQuery.trim().toLowerCase();
  return state.effects.filter((item) => {
    if (state.effectFavoritesOnly && !effectIsFavorite(item.matchName)) return false;
    if (state.effectPlugin !== "all" && effectGroupLabel(item) !== state.effectPlugin) return false;
    if (state.effectCategory !== "all") {
      const category = effectCategoryKey(item);
      if (state.effectCategory === "__favorites__") {
        if (!effectIsFavorite(item.matchName)) return false;
      } else if (state.effectCategory === "__uncategorized__") {
        if (category) return false;
      } else if (effectGroupLabel(item) + "\u0000" + category !== state.effectCategory) {
        return false;
      }
    }
    if (!query) return true;
    const haystack = [
      item.name,
      item.nameZh,
      item.nameEn,
      item.matchName,
      item.displayName,
      item.category,
      item.categoryZh,
      item.categoryEn,
      item.plugin,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function effectCategoryRow(id, label, count) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  const active = state.effectCategory === id;
  button.className =
    "category-item" + (id === "__favorites__" ? " favorite-category" : "") + (active ? " active" : "");
  const text = document.createElement("span");
  text.className = "category-label";
  text.textContent = label;
  const badge = document.createElement("span");
  badge.className = "category-count";
  badge.textContent = String(count);
  button.appendChild(text);
  button.appendChild(badge);
  button.addEventListener("click", () => {
    state.effectCategory = id;
    if (id === "__favorites__") {
      /* 收藏是「分类选择」：显示全部收藏，清掉搜索并重置来源 */
      state.effectPlugin = "all";
      state.effectQuery = "";
      const search = $("effectSearch");
      if (search) search.value = "";
    } else if (id === "all" || id === "__uncategorized__") {
      state.effectPlugin = "all";
    } else {
      state.effectPlugin = effectGroupFromKey(id);
    }
    paintEffectsLibrary();
  });
  li.appendChild(button);
  return li;
}

function renderEffectCategories(groups) {
  const list = $("effectCategoryList");
  if (!list) return;
  const available = new Set(["all", "__uncategorized__", "__favorites__"]);
  for (const group of groups) {
    for (const row of group.categories) {
      available.add(group.label + "\u0000" + row.category);
    }
  }
  if (!available.has(state.effectCategory)) state.effectCategory = "all";

  list.textContent = "";
  list.appendChild(
    effectCategoryRow(
      "__favorites__",
      "收藏",
      state.effects.filter((item) => effectIsFavorite(item.matchName)).length,
    ),
  );
  list.appendChild(effectCategoryRow("all", "全部效果", state.effects.length));
  const uncategorized = state.effects.filter((item) => !effectCategoryKey(item)).length;
  if (uncategorized) {
    list.appendChild(effectCategoryRow("__uncategorized__", "未分类", uncategorized));
  }
  for (const group of groups) {
    const collapsed = !!state.effectGroupCollapsed[group.label];
    list.appendChild(effectGroupHeaderRow(group, collapsed));
    if (collapsed) continue;
    for (const row of group.categories) {
      list.appendChild(
        effectCategoryRow(group.label + "\u0000" + row.category, row.category, row.count),
      );
    }
  }
}

/* 来源分组头：可点击折叠，箭头 ▾（展开）/ ▸（收起），状态持久化在 localStorage */
function effectGroupHeaderRow(group, collapsed) {
  const li = document.createElement("li");
  li.className = "effect-group-toggle";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "category-item category-group-head" + (collapsed ? " collapsed" : "");
  button.setAttribute("aria-expanded", collapsed ? "false" : "true");
  const rendered = group.items.filter((item) => effectHasPreview(item)).length;
  button.title =
    `共 ${group.items.length} 条` + (rendered ? `，已生成 ${rendered} 条` : "");
  const arrow = document.createElement("span");
  arrow.className = "group-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "▾";
  const label = document.createElement("span");
  label.className = "category-label";
  label.textContent = group.label;
  const count = document.createElement("span");
  count.className = "category-count";
  count.textContent = String(group.items.length);
  button.appendChild(arrow);
  button.appendChild(label);
  button.appendChild(count);
  button.addEventListener("click", () => toggleEffectGroupCollapsed(group.label));
  li.appendChild(button);
  return li;
}

function readEffectCollapsedGroups() {
  try {
    const raw = localStorage.getItem(EFFECT_GROUP_COLLAPSED_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [label, value] of Object.entries(parsed)) {
      if (value) state.effectGroupCollapsed[label] = true;
    }
  } catch {
    /* 本地状态损坏时按全部展开处理 */
  }
}

function saveEffectCollapsedGroups() {
  try {
    const doc = {};
    for (const [label, value] of Object.entries(state.effectGroupCollapsed)) {
      if (value) doc[label] = true;
    }
    localStorage.setItem(EFFECT_GROUP_COLLAPSED_KEY, JSON.stringify(doc));
  } catch {
    /* 持久化失败不影响本次使用 */
  }
}

function toggleEffectGroupCollapsed(label) {
  if (state.effectGroupCollapsed[label]) delete state.effectGroupCollapsed[label];
  else state.effectGroupCollapsed[label] = true;
  saveEffectCollapsedGroups();
  /* 只重绘分类栏：折叠不影响网格，避免 1000+ 张卡片跟着重建 */
  renderEffectCategories(effectGroups());
}

function fillEffectPluginSelect(groups) {
  const select = $("effectPluginFilter");
  if (!select) return;
  const labels = groups.map((group) => group.label);
  if (state.effectPlugin !== "all" && !labels.includes(state.effectPlugin)) {
    state.effectPlugin = "all";
  }
  select.textContent = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "全部来源";
  select.appendChild(all);
  for (const label of labels) {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    select.appendChild(option);
  }
  select.value = state.effectPlugin;
}

function effectSpritePosition(item) {
  const cellSize = Math.max(1, Number(item.cellSize) || 128);
  const columns = Math.max(1, Number(item.columns) || 1);
  const rows = Math.max(1, Number(item.rows) || 1);
  const x = Number(item.x) || 0;
  const y = Number(item.y) || 0;
  const posX = columns > 1 ? (x / cellSize / (columns - 1)) * 100 : 0;
  const posY = rows > 1 ? (y / cellSize / (rows - 1)) * 100 : 0;
  return {
    size: `${columns * 100}% ${rows * 100}%`,
    position: `${posX.toFixed(4)}% ${posY.toFixed(4)}%`,
  };
}

/* 内置是 8×8 整网、插件是单行 8 格：用背景百分比裁切，格子永远精确等于缩略框 */
function applyEffectPreview(preview, item, frameIndex) {
  if (!preview) return;
  const slice = effectSpritePosition(item);
  preview.style.backgroundSize = slice.size;
  preview.style.backgroundPosition = slice.position;
  const url = frameUrl(item, frameIndex);
  if (url) preview.style.backgroundImage = `url("${url}")`;
}

function bindEffectHoverPreview(card, preview, item) {
  if (!item.animated || Number(item.frames) <= 1 || !item.framePattern) return;
  const frames = Math.max(1, Number(item.frames) || 1);
  const fps = Math.max(1, Number(item.fps) || 12);
  const delay = Math.max(40, Math.round(1000 / fps));
  const stillFrame = Math.min(frames - 1, Math.max(0, Number(item.stillFrame) || 0));
  const frameNodes = [];
  let preloaded = false;
  let timer = null;

  function preload() {
    if (preloaded) return;
    preloaded = true;
    for (let i = 0; i < frames; i++) {
      const node = new Image();
      node.src = frameUrl(item, i);
      frameNodes.push(node);
    }
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    applyEffectPreview(preview, item, stillFrame);
    if (state.effectHoverStop === stop) state.effectHoverStop = null;
  }

  card.addEventListener("mouseenter", () => {
    if (state.effectHoverStop && state.effectHoverStop !== stop) state.effectHoverStop();
    state.effectHoverStop = stop;
    preload();
    if (timer) clearInterval(timer);
    let index = 0;
    applyEffectPreview(preview, item, index);
    timer = setInterval(() => {
      index = (index + 1) % frames;
      applyEffectPreview(preview, item, index);
    }, delay);
  });
  card.addEventListener("mouseleave", stop);
}

function bindEffectFavoriteButton(thumb, item) {
  const active = effectIsFavorite(item.matchName);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "card-favorite-toggle" + (active ? " active" : "");
  button.dataset.matchName = String(item.matchName || "");
  button.setAttribute("aria-pressed", active ? "true" : "false");
  button.title = active ? "取消收藏" : "收藏";
  button.innerHTML =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z"/></svg>';
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await toggleEffectFavorite(item);
  });
  button.addEventListener("dblclick", (event) => event.stopPropagation());
  thumb.appendChild(button);
}

function bindEffectSelectCheckbox(thumb, item) {
  if (!item.renderable) return;
  const label = document.createElement("label");
  label.className = "card-select";
  label.title = "选择这个效果用于渲染";
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = effectIsSelected(item.matchName);
  box.setAttribute("aria-label", "选择 " + effectDisplayName(item));
  label.appendChild(box);
  const swallow = (event) => event.stopPropagation();
  label.addEventListener("pointerdown", swallow);
  label.addEventListener("click", swallow);
  label.addEventListener("dblclick", swallow);
  box.addEventListener("change", () => {
    const matchName = String(item.matchName || "");
    if (box.checked) state.effectSelection.set(matchName, item);
    else state.effectSelection.delete(matchName);
    updateEffectSelectionUI();
    paintEffectHint(visibleEffects().length);
    setStatus(
      state.effectSelection.size
        ? `已选择 ${state.effectSelection.size} 个效果`
        : "已清空效果选择",
    );
  });
  thumb.appendChild(label);
}

async function toggleEffectFavorite(item) {
  const matchName = String((item && item.matchName) || "");
  if (!matchName) return;
  if (!hubHas("toggleEffectFavorite")) {
    setStatus("主进程尚未提供效果收藏接口", true);
    return;
  }
  let result = null;
  try {
    result = await window.hub.toggleEffectFavorite(matchName);
  } catch {
    result = null;
  }
  if (!result || !result.ok) {
    setStatus("收藏失败：" + ((result && result.reason) || "未知原因"), true);
    return;
  }
  applyEffectFavorites(result.items);
  if (state.effectFavoritesOnly || state.effectCategory === "__favorites__") {
    paintEffectsLibrary();
  } else {
    updateEffectFavoriteButtons();
    renderEffectCategories(effectGroups());
    paintEffectHint(visibleEffects().length);
  }
  setStatus(
    result.favorite
      ? `已收藏「${effectDisplayName(item)}」`
      : `已取消收藏「${effectDisplayName(item)}」`,
  );
}

function selectUnrenderedEffects() {
  const candidates = visibleEffects().filter(
    (item) => item.renderable && !item.hasPreview && item.status === "pending",
  );
  if (!candidates.length) {
    setStatus("当前筛选下没有待渲染的插件效果", true);
    return;
  }
  for (const item of candidates) {
    state.effectSelection.set(String(item.matchName || ""), item);
  }
  updateEffectSelectionUI();
  paintEffectHint(visibleEffects().length);
  setStatus(`已选择 ${candidates.length} 个待渲染效果`);
}

function clearEffectLibrarySelection() {
  if (!state.effectSelection.size) return;
  state.effectSelection.clear();
  updateEffectSelectionUI();
  paintEffectHint(visibleEffects().length);
  setStatus("已清空效果选择");
}

/* 与渲染页「选择效果」共用同一个启动接口（预览渲染流程） */
async function renderSelectedEffects() {
  const items = [...state.effectSelection.values()];
  if (!items.length) return;
  handoffToPreview("effect", {
    items: items.map(effectPlanItem),
    entry: { view: "effects" },
  });
}

async function renderSingleEffect(item) {
  if (!item || !item.renderable) {
    setStatus("这个效果不能预览渲染", true);
    return;
  }
  handoffToPreview("effect", {
    items: [effectPlanItem(item)],
    entry: { view: "effects" },
  });
}

/* 右键「手动调参…」：种入这一条并直接展开调参 */
function openEffectTuning(item) {
  if (!item) return;
  handoffToPreview("effect", {
    items: [effectPlanItem(item)],
    entry: { view: "effects" },
    manualTuning: true,
  });
}

async function clearEffectRender(item) {
  if (!item || !item.generated) return;
  if (!hubHas("clearEffectRender")) {
    setStatus("主进程尚未提供取消渲染接口", true);
    return;
  }
  let result = null;
  try {
    result = await window.hub.clearEffectRender(item.matchName);
  } catch {
    result = null;
  }
  if (!result || !result.ok) {
    setStatus("取消渲染失败：" + ((result && result.reason) || "未知原因"), true);
    return;
  }
  await loadEffects();
  const deleted = Number(result.deleted) || 0;
  setStatus(
    `已取消「${effectDisplayName(item)}」的预览渲染` + (deleted ? `，清理 ${deleted} 个文件` : ""),
  );
}

/* 效果库右键菜单：复用预设库的 #categoryMenu 容器与 menuButton 帮助函数 */
function openEffectMenu(item, x, y) {
  const menu = $("categoryMenu");
  if (!menu) return;
  menu.textContent = "";
  menu.appendChild(menuTitle(effectDisplayName(item)));
  const favorite = effectIsFavorite(item.matchName);
  menu.appendChild(menuButton(favorite ? "取消收藏" : "收藏", favorite, false, () =>
    toggleEffectFavorite(item),
  ));
  if (item.renderable) {
    menu.appendChild(menuButton("预览渲染此条", false, false, () => renderSingleEffect(item)));
  }
  if (item.source === "plugin" || item.manual) {
    menu.appendChild(menuButton("手动调参…", false, false, () => openEffectTuning(item)));
  }
  if (item.generated) {
    menu.appendChild(menuButton("取消渲染", false, true, () => clearEffectRender(item)));
  }
  showCategoryMenu(x, y);
}


/** 手动调参启动的独立 AE 版本；下拉与「渲染」页共用 .ae-version-select，切换时全局同步。 */
function effectCardNode(item) {
  const card = document.createElement("div");
  card.className = "card" + (effectIsSelected(item.matchName) ? " selected" : "");
  card.dataset.matchName = String(item.matchName || "");

  const name = effectDisplayName(item);
  const category = effectCategoryLabel(item);
  const hasPreview = effectHasPreview(item);
  const frames = Math.max(1, Number(item.frames) || 1);
  const stillFrame = Math.min(frames - 1, Math.max(0, Number(item.stillFrame) || 0));

  const thumb = document.createElement("div");
  thumb.className = "card-thumb";
  let preview = null;
  if (hasPreview && item.framePattern) {
    preview = document.createElement("div");
    preview.className = "effect-preview";
    applyEffectPreview(preview, item, stillFrame);
    thumb.appendChild(preview);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    placeholder.textContent = effectStatusLabel(item);
    thumb.appendChild(placeholder);
  }
  if (hasPreview && !item.animated) {
    const dot = document.createElement("span");
    dot.className = "card-static-dot";
    dot.title = "静止帧";
    thumb.appendChild(dot);
  }
  if (preview) bindEffectHoverPreview(card, preview, item);
  bindEffectSelectCheckbox(thumb, item);
  bindEffectFavoriteButton(thumb, item);

  const body = document.createElement("div");
  body.className = "card-body";
  const nameNode = document.createElement("div");
  nameNode.className = "card-name";
  nameNode.textContent = name;
  const categoryNode = document.createElement("div");
  categoryNode.className = "card-category";
  categoryNode.textContent = category;
  body.appendChild(nameNode);
  body.appendChild(categoryNode);
  if (item.manual) {
    const manualBadge = document.createElement("span");
    manualBadge.className = "card-manual-badge" + (item.manualUnverified ? " warning" : "");
    manualBadge.textContent = item.manualUnverified ? "手动⚠" : "手动";
    manualBadge.title = item.manualVerified
      ? "手动覆盖已通过写入验证"
      : item.manualUnverified
        ? "手动覆盖中有参数写入后像素无变化"
        : "使用手动覆盖表，尚未验证写入";
    body.appendChild(manualBadge);
  }

  const statusLabel = hasPreview ? "" : effectStatusLabel(item);
  card.title = [name, String(item.matchName || ""), category, statusLabel]
    .filter(Boolean)
    .join("\n");
  card.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openEffectMenu(item, event.clientX, event.clientY);
  });
  card.appendChild(thumb);
  card.appendChild(body);
  return card;
}

function paintEffectEmpty(hasData) {
  const empty = $("emptyEffects");
  if (!empty) return;
  const title = document.createElement("p");
  title.className = "empty-title";
  const subs = [];
  if (hasData) {
    title.textContent = "没有符合筛选的效果";
    subs.push("试试清空搜索、切换来源，或者点左侧的「全部效果」。");
  } else {
    title.textContent = "效果库还是空的";
    subs.push("插件效果要先到「渲染」页生成预览，生成后会自动出现在这里。");
    subs.push("内置效果预览随 DreamEngine 面板安装，装好后重启 Hub 就能看到。");
    subs.push("分类会跟随 After Effects 自动同步，不用手动新建。");
  }
  empty.textContent = "";
  empty.appendChild(title);
  for (const text of subs) {
    const sub = document.createElement("p");
    sub.className = "empty-sub";
    sub.textContent = text;
    empty.appendChild(sub);
  }
}

function effectCounts() {
  const counts = (state.effectData && state.effectData.counts) || {};
  const total = Number(counts.total) || state.effects.length;
  const builtin =
    Number(counts.builtin) || state.effects.filter((item) => item.source === "builtin").length;
  const plugin = Number(counts.plugin) || Math.max(0, total - builtin);
  const rendered =
    Number(counts.rendered) || state.effects.filter((item) => effectHasPreview(item)).length;
  const categories =
    Number(counts.categories) ||
    new Set(state.effects.map((item) => effectCategoryKey(item)).filter(Boolean)).size;
  return { total, builtin, plugin, rendered, categories };
}

function paintEffectHint(shown) {
  const hint = $("effectHint");
  if (!hint) return;
  const counts = effectCounts();
  if (!counts.total) {
    hint.textContent = "";
    return;
  }
  const parts = [
    `共 ${counts.total} 个效果`,
    `内置 ${counts.builtin}`,
    `插件 ${counts.plugin}`,
    `已生成预览 ${counts.rendered}`,
    `${counts.categories} 个分类`,
  ];
  if (state.effectSelection.size) parts.push(`已选 ${state.effectSelection.size}`);
  const filtering =
    !!state.effectQuery.trim() ||
    state.effectCategory !== "all" ||
    state.effectPlugin !== "all" ||
    state.effectFavoritesOnly;
  if (filtering) parts.push(`当前显示 ${shown} 个`);
  hint.textContent = parts.join(" · ");
}

/* 工具栏的「仅显示已收藏效果」是独立开关（与侧栏收藏分类选择分开） */
function syncEffectFavoritesOnlyButton() {
  const button = $("btnEffectFavoritesOnly");
  if (!button) return;
  button.setAttribute("aria-pressed", state.effectFavoritesOnly ? "true" : "false");
}

function paintEffectSyncButton() {
  const button = $("btnEffectSyncCategories");
  if (!button) return;
  const scanning = !!state.pluginCatalogScanning;
  button.disabled = scanning || anyJobBusy() || !hubHas("scanPluginEffects");
  button.textContent = scanning ? "正在同步…" : "同步 AE 分类";
}

function paintEffectsLibrary() {
  const grid = $("effectGrid");
  if (!grid) return;
  if (state.effectHoverStop) state.effectHoverStop();
  const groups = effectGroups();
  renderEffectCategories(groups);
  fillEffectPluginSelect(groups);
  const items = visibleEffects();

  grid.textContent = "";
  grid.hidden = items.length === 0;
  const empty = $("emptyEffects");
  if (empty) empty.hidden = items.length > 0;
  if (!items.length) paintEffectEmpty(state.effects.length > 0);
  for (const item of items) grid.appendChild(effectCardNode(item));

  $("tabEffectCount").textContent = String(effectCounts().total);
  updateEffectSelectionUI();
  syncEffectFavoritesOnlyButton();
  paintEffectHint(items.length);
  paintEffectSyncButton();
}

async function loadEffects() {
  let data = null;
  if (hubHas("listEffects")) {
    try {
      data = await window.hub.listEffects();
    } catch {
      data = null;
    }
  }
  state.effectData = data && data.ok ? data : null;
  state.effects = data && data.ok && Array.isArray(data.items) ? data.items : [];
  const favorites =
    data && data.ok && Array.isArray(data.favorites)
      ? data.favorites
      : data && data.ok
        ? state.effects.filter((item) => item.favorite).map((item) => item.matchName)
        : [];
  applyEffectFavorites(favorites);
  pruneEffectSelection();
  paintEffectsLibrary();
}

async function refreshEffects() {
  await loadEffects();
  setStatus("已刷新");
}

async function syncEffectCategories() {
  if (state.pluginCatalogScanning) return;
  if (!hubHas("scanPluginEffects")) {
    setStatus("主进程尚未提供扫描插件目录接口", true);
    return;
  }
  const ae = (state.snapshot && state.snapshot.catalogMeta && state.snapshot.catalogMeta.aeExe) || "";
  setStatus("正在同步 AE 分类…");
  state.pluginCatalogScanning = true;
  try {
    const started = await window.hub.scanPluginEffects({ ae });
    if (!started || !started.ok) {
      setStatus("扫描启动失败：" + ((started && started.reason) || "未知原因"), true);
      return;
    }
    for (let i = 0; i < 300; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const snap = await window.hub.pluginEffectsSnapshot();
      const st = (snap && snap.state) || snap || {};
      if (st.phase === "done" || st.phase === "failed" || st.phase === "cancelled") break;
    }
    await refreshPluginCatalog();
    await loadEffects();
    setStatus("插件目录已同步");
  } catch (error) {
    setStatus("同步 AE 分类失败：" + String((error && error.message) || error), true);
  } finally {
    state.pluginCatalogScanning = false;
    paintEffectsLibrary();
  }
}

/* ---------- 渲染页 ---------- */

async function refreshAeState() {
  const snap = await window.hub.snapshot();
  state.snapshot = snap;
  const badge = $("aeState");
  if (badge) {
    const ae = snap.ae || {};
    const first = (ae.installed || [])[0];
    badge.textContent = ae.running
      ? "After Effects 运行中"
      : first
        ? "After Effects " + (first.version || "")
        : "After Effects 未安装";
  }
  fillSettings(snap);
  return snap;
}

function closeRenderLog() {
  $("renderLogDialog").hidden = true;
}

async function renderSinglePreset(item) {
  if (!item || !item.path) return;
  handoffToPreview("preset", {
    items: [
      {
        key: item.path,
        name: item.name || item.path.split(/[\\/]/).pop() || item.path,
        meta: [item.external ? "AE 预设" : "我的预设", item.rendered ? "已生成" : "未生成"].join(" · "),
        status: item.rendered ? "rendered" : "pending",
        presetPath: item.path,
      },
    ],
    entry: { view: "presets" },
  });
}

/* ---------- 插件效果预览 ---------- */

/* ---------- 插件目录 / 选择效果 ---------- */

const EFFECT_STATUS = {
  pending: { label: "待渲染", className: "pending" },
  rendered: { label: "已生成", className: "rendered" },
  blacklisted: { label: "已跳过", className: "skipped" },
  excluded: { label: "不可渲染", className: "blocked" },
  no_preview: { label: "不可渲染", className: "blocked" },
};

const EFFECT_REASONS = {
  pseudo: "伪效果",
  obsolete: "已过时",
  no_category: "没有分类",
  poor_preview: "预览效果差",
  crash: "渲染崩溃",
  render_error: "渲染报错",
  render_timeout: "渲染超时",
  ae_dialog: "AE 报错",
};

function effectDisplayName(item) {
  return item.displayName || item.nameZh || item.nameEn || item.matchName || "(未命名效果)";
}

function effectReasonLabel(item) {
  if (!item || !item.reason) return "";
  return EFFECT_REASONS[item.reason] || String(item.reason);
}

function catalogItems() {
  return (state.pluginCatalog && state.pluginCatalog.items) || [];
}

async function refreshPluginCatalog() {
  let catalog = null;
  if (hubHas("pluginEffectsCatalog")) {
    try {
      catalog = await window.hub.pluginEffectsCatalog();
    } catch {
      catalog = null;
    }
  }
  state.pluginCatalog = catalog && catalog.ok ? catalog : null;
}

/* ---------- 设置页 ---------- */

function fillSettings(snap) {
  const ext = snap.ext;
  $("extVersion").textContent = ext.version ? "v" + ext.version : "";
  $("setExtDir").textContent = ext.extDir;
  $("setExtVersion").textContent = ext.installed
    ? ext.version || "已安装"
    : "未安装（请先跑安装包）";
  $("setThumbs").textContent = ext.thumbCount + " 张";
  $("setIndexes").textContent = ext.indexes.length
    ? ext.indexes.join("、")
    : "（还没有生成过索引）";

  $("setAeRun").textContent = snap.ae.running ? "运行中" : "未运行";
  $("setAeList").textContent = snap.ae.installed.length
    ? snap.ae.installed.map((v) => v.name).join("、")
    : "未检测到";

  $("setPresets").textContent = snap.paths.presets;
  $("setBg").textContent = snap.paths.backgrounds;
  $("setProbe").textContent = snap.paths.probe;
  const cacheNode = $("setParamsCache");
  if (cacheNode) cacheNode.textContent = snap.paths.effectParams || "—";
  const guardNode = $("setAeGuard");
  if (guardNode) {
    guardNode.checked =
      window.PreviewFlow && window.PreviewFlow.aeGuardEnabled
        ? window.PreviewFlow.aeGuardEnabled()
        : true;
  }
}

/* ---------- 绑定 ---------- */

/* 卡片 3D 聚焦：指针在卡片上移动时轻微倾斜并跟随高光，离开后回正。
   用事件委托绑在网格上，卡片重建后无需重新绑定。 */
function bindCardTilt(grid) {
  if (!grid) return;
  let active = null;
  let frame = 0;

  const reset = (card) => {
    if (!card) return;
    card.style.removeProperty("--tilt-x");
    card.style.removeProperty("--tilt-y");
  };

  grid.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch") return;
    const target = event.target instanceof Element ? event.target : null;
    const card = target && target.closest(".card");
    if (!card || card.parentElement !== grid) return;
    if (active && active !== card) reset(active);
    active = card;
    const rect = card.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const px = (event.clientX - rect.left) / rect.width - 0.5;
    const py = (event.clientY - rect.top) / rect.height - 0.5;
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      card.style.setProperty("--tilt-x", `${(-py * 8).toFixed(2)}deg`);
      card.style.setProperty("--tilt-y", `${(px * 10).toFixed(2)}deg`);
      card.style.setProperty("--glare-x", `${((px + 0.5) * 100).toFixed(1)}%`);
      card.style.setProperty("--glare-y", `${((py + 0.5) * 100).toFixed(1)}%`);
    });
  });

  grid.addEventListener("pointerout", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const card = target && target.closest(".card");
    if (!card || card.parentElement !== grid) return;
    if (card.contains(event.relatedTarget)) return;
    reset(card);
    if (active === card) active = null;
  });

  grid.addEventListener("pointerleave", () => {
    reset(active);
    active = null;
  });
}

function bind() {
  bindCardTilt($("grid"));
  bindCardTilt($("effectGrid"));
  presetSidebar.init();
  effectSidebar.init();
  readEffectCollapsedGroups();
  document.getElementById("tabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (tab) setView(tab.dataset.view);
  });

  $("btnImport").addEventListener("click", addPresets);
  $("btnCategoryAdd").addEventListener("click", () => openCategoryEditor("create", null));
  $("categoryEditor").addEventListener("submit", saveCategory);
  $("categoryCancel").addEventListener("click", closeCategoryEditor);
  $("categoryName").addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeCategoryEditor();
  });
  document.addEventListener("mousedown", (event) => {
    const menu = $("categoryMenu");
    if (!menu.hidden && !menu.contains(event.target)) hideCategoryMenu();
  });
  $("presetDeleteCancel").addEventListener("click", closePresetDelete);
  $("presetDeleteConfirm").addEventListener("click", confirmPresetDelete);
  $("presetDeleteDialog").addEventListener("mousedown", (event) => {
    if (event.target === $("presetDeleteDialog")) closePresetDelete();
  });
  $("presetRenameForm").addEventListener("submit", savePresetRename);
  $("presetRenameCancel").addEventListener("click", closePresetRename);
  $("presetRenameDialog").addEventListener("mousedown", (event) => {
    if (event.target === $("presetRenameDialog")) closePresetRename();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("presetDeleteDialog").hidden) closePresetDelete();
    if (event.key === "Escape" && !$("presetRenameDialog").hidden) closePresetRename();
    if (event.key === "Escape") hideCategoryMenu();
  });

  const presetView = $("viewPresets");
  presetView.addEventListener("dragenter", (event) => {
    if ([...(event.dataTransfer?.types || [])].includes("Files")) {
      presetView.classList.add("drop-over");
    }
  });
  presetView.addEventListener("dragover", (event) => {
    if ([...(event.dataTransfer?.types || [])].includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  });
  presetView.addEventListener("dragleave", (event) => {
    if (!presetView.contains(event.relatedTarget)) presetView.classList.remove("drop-over");
  });
  presetView.addEventListener("drop", async (event) => {
    event.preventDefault();
    presetView.classList.remove("drop-over");
    await addDroppedPresets([...(event.dataTransfer?.files || [])]);
  });

  $("btnRefresh").addEventListener("click", async () => {
    await loadPresets();
    setStatus("已刷新");
  });

  $("btnSelectUnrendered").addEventListener("click", selectUnrenderedPresets);
  $("btnClearSelection").addEventListener("click", clearPresetSelection);
  $("btnRenderSelected").addEventListener("click", renderSelectedPresets);
  $("btnSyncAePresets").addEventListener("click", () => syncAePresets(true));
  $("btnPresetFavoritesOnly").addEventListener("click", () => {
    state.presetFavoritesOnly = !state.presetFavoritesOnly;
    renderPresets();
  });
  $("presetSourceFilter").addEventListener("change", (event) => {
    state.presetSourceFilter = event.target.value;
    if (state.presetSourceFilter === "mine" && state.presetCategory.startsWith("ae:")) {
      state.presetCategory = "all";
    } else if (
      state.presetSourceFilter === "external" &&
      state.presetCategory !== "all" &&
      !state.presetCategory.startsWith("ae:") &&
      state.presetCategory !== "__favorites__"
    ) {
      state.presetCategory = "all";
    }
    renderPresets();
  });

  $("search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderPresets();
  });

  $("btnEffectRefresh").addEventListener("click", refreshEffects);
  $("btnEffectSyncCategories").addEventListener("click", syncEffectCategories);
  $("btnEffectSelectUnrendered").addEventListener("click", selectUnrenderedEffects);
  $("btnEffectClearSelection").addEventListener("click", clearEffectLibrarySelection);
  $("btnEffectRenderSelected").addEventListener("click", renderSelectedEffects);
  $("btnEffectFavoritesOnly").addEventListener("click", () => {
    state.effectFavoritesOnly = !state.effectFavoritesOnly;
    paintEffectsLibrary();
  });
  $("effectSearch").addEventListener("input", (event) => {
    state.effectQuery = event.target.value;
    paintEffectsLibrary();
  });
  $("effectPluginFilter").addEventListener("change", (event) => {
    state.effectPlugin = event.target.value;
    if (
      state.effectPlugin !== "all" &&
      state.effectCategory !== "all" &&
      state.effectCategory !== "__uncategorized__" &&
      state.effectCategory !== "__favorites__" &&
      effectGroupFromKey(state.effectCategory) !== state.effectPlugin
    ) {
      state.effectCategory = "all";
    }
    paintEffectsLibrary();
  });

  $("renderLogClose").addEventListener("click", closeRenderLog);
  $("renderLogCloseBottom").addEventListener("click", closeRenderLog);
  $("renderLogOpenFolder").addEventListener("click", () => {
    if (state.snapshot) window.hub.reveal(state.snapshot.paths.probe);
  });
  $("renderLogDialog").addEventListener("click", (event) => {
    if (event.target === $("renderLogDialog")) closeRenderLog();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("renderLogDialog").hidden) {
      event.preventDefault();
      closeRenderLog();
    }
  });

  $("btnOpenExt").addEventListener("click", () => window.hub.reveal($("setExtDir").textContent));
  $("btnOpenPresets").addEventListener("click", () => window.hub.reveal($("setPresets").textContent));
  $("btnOpenProbe").addEventListener("click", () => window.hub.reveal($("setProbe").textContent));
  $("btnOpenParamsCache").addEventListener("click", async () => {
    if (!hubHas("openEffectParamsDir")) {
      setStatus("主进程尚未提供属性缓存目录接口", true);
      return;
    }
    const ok = await window.hub.openEffectParamsDir();
    if (!ok) setStatus("打开属性缓存目录失败", true);
  });
  $("setAeGuard").addEventListener("change", (event) => {
    if (!(window.PreviewFlow && window.PreviewFlow.setAeGuardEnabled)) return;
    window.PreviewFlow.setAeGuardEnabled(!!event.target.checked);
    setStatus(event.target.checked ? "已开启 AE 崩溃修复自动处理" : "已关闭 AE 崩溃修复自动处理");
  });

}

async function boot() {
  bind();
  const snap = await refreshAeState();
  await loadPresetCategories();
  await loadPresets();
  await loadEffects();
  await refreshPluginCatalog();

  if (!snap.ext.installed) {
    setStatus("没有检测到已安装的 DreamEngine 面板，先跑安装包里的安装脚本", true);
  }
}

boot();
