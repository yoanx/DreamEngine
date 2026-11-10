/* ============================================================
 * i18n.js —— 界面文案字典（中 / 英）
 *
 * 为什么单列一个文件：文案散在 index.html 与四五个脚本里，一旦要加语言
 * 就得满仓库找字符串。集中到一张表之后：
 *   · 静态文案在 HTML 上标 data-i18n="key"，applyI18n() 统一替换
 *   · 动态文案在 JS 里用 L("key") 取当前语言
 *
 * 约定：
 *   · 每一项是 [中文, English] 两元数组，顺序固定
 *   · 带占位符的用 {0} {1}，替换走 L("key", [a, b])
 *   · 不要在这里放 HTML 标签 —— 全部按纯文本写入（textContent）
 *
 * 语法：ES5（与其它面板脚本一致）。
 * ============================================================ */

var AEV_I18N = {
  /* ---------- 顶栏 / 视图切换 ---------- */
  "tab.effects": ["效果", "Effects"],
  "tab.presets": ["预设", "Presets"],
  "tab.curve": ["曲线", "Curves"],
  "tab.materials": ["素材", "Materials"],
  "app.title": ["DreamEngine", "DreamEngine"],
  "tab.aria": ["主视图切换", "Main views"],
  "lang.zhTitle": ["中文", "Chinese"],
  "lang.enTitle": ["English", "English"],
  "common.cancel": ["取消", "Cancel"],
  "favorites.filter": ["收藏", "Favorites"],
  "favorites.add": ["收藏", "Add to favorites"],
  "favorites.remove": ["取消收藏", "Remove from favorites"],

  /* ---------- 介绍弹窗 ---------- */
  "about.open": ["关于 DreamEngine", "About DreamEngine"],
  "about.close": ["关闭介绍", "Close about"],
  "about.linksAria": ["作者链接", "Creator links"],
  "about.tagline": ["AE 效果 / 预设 / 曲线 / 素材", "AE effects / presets / curves / media"],
  "about.douyin": ["抖音", "Douyin"],
  "about.github": ["GitHub 源码", "GitHub source"],
  "about.qqGroup": ["QQ 交流群", "QQ group"],
  "about.copy": ["复制", "Copy"],
  "about.copied": ["已复制", "Copied"],
  "about.copyFailed": ["复制失败", "Copy failed"],

  /* ---------- 效果墙 ---------- */
  "search.effects": ["搜索效果、分类或 matchName", "Search effects, categories or matchName"],
  "filter.plugin": ["插件筛选", "Plugin filter"],
  "filter.all": ["全部来源", "All sources"],
  "filter.builtin": ["内置", "Built-in"],
  "filter.other": ["其它插件", "Other plugins"],
  "sort.group": ["排序", "Sort"],
  "sort.name": ["按名称", "By name"],
  "sort.category": ["按分类", "By category"],
  "toggle.showAll": ["全部已安装", "Show all installed"],
  "sidebar.title": ["分类", "Categories"],
  "sidebar.resize": ["调整分类栏宽度", "Resize categories"],
  "sidebar.all": ["全部", "All"],
  "empty.effects": ["没有匹配的效果", "No matching effects"],
  "card.addHint": ["（双击或点 + 添加到 AE 选中图层）", " (double-click or click + to add to the selected layer)"],
  "card.addButton": ["添加到选中层", "Add to selected layer"],

  /* ---------- 预设视图 ---------- */
  "preset.title": ["预设库", "Preset library"],
  "preset.search": ["搜索预设", "Search presets"],
  "preset.openHub": ["打开 DreamEngine Hub", "Open DreamEngine Hub"],
  "preset.addCategory": ["新建预设分类", "New preset category"],
  "preset.categoryName": ["分类名称", "Category name"],
  "preset.saveCategory": ["保存分类", "Save category"],
  "preset.uncategorized": ["未分类", "Uncategorized"],
  "preset.allCategories": ["全部预设", "All presets"],
  "preset.moveCategory": ["移动到分类", "Move to category"],
  "preset.removeCategory": ["移出分类", "Remove from category"],
  "preset.renameCategory": ["重命名分类", "Rename category"],
  "preset.deleteCategory": ["删除分类", "Delete category"],
  "preset.categoryExists": ["分类名称已存在", "That category name already exists"],
  "preset.categoryCreated": ["已新建分类「{0}」", "Created category “{0}”"],
  "preset.categoryRenamed": ["分类已重命名", "Category renamed"],
  "preset.categoryDeleted": ["分类已删除，原预设回到未分类", "Category deleted; its presets are now uncategorized"],
  "preset.deleteTitle": ["删除预设", "Delete preset"],
  "preset.deleteQuestion": ["确定删除预设「{0}」？对应的 .ffx 文件会从预设库中移除。",
    "Delete preset “{0}”? The .ffx file will be removed from the preset library."],
  "preset.deleteCancel": ["取消", "Cancel"],
  "preset.deleteConfirm": ["删除", "Delete"],
  "preset.deleted": ["已删除预设「{0}」", "Deleted preset “{0}”"],
  "preset.deleteFailed": ["删除预设失败：{0}", "Failed to delete preset: {0}"],
  /* ---------- 素材视图 ---------- */
  "materials.aria": ["素材库", "Materials"],
  "materials.title": ["素材库", "Materials"],
  "materials.categories": ["素材分类", "Material categories"],
  "materials.chooseRoot": ["选择素材目录", "Choose media folder"],
  "materials.refresh": ["刷新", "Refresh"],
  "materials.search": ["搜索素材", "Search materials"],
  "materials.empty": ["当前分类没有素材", "No materials in this category"],
  "materials.noRoot": ["尚未选择素材根目录", "No media root selected"],
  "materials.all": ["全部素材", "All materials"],
  "materials.video": ["视频", "Video"],
  "materials.image": ["图片", "Image"],
  "materials.audio": ["音频", "Audio"],
  "materials.project": ["工程", "Projects"],
  "materials.script": ["脚本", "Scripts"],
  "materials.missing": ["文件缺失", "Missing file"],
  "materials.summary": ["共 {0} 个素材 · 当前显示 {1} 个", "{0} materials · {1} shown"],
  "materials.scanned": ["已索引 {0} 个素材", "Indexed {0} materials"],
  "materials.readFailed": ["读取素材索引失败：{0}", "Could not read the material index: {0}"],
  "materials.imported": ["已导入「{0}」", "Imported “{0}”"],
  "materials.importedProject": ["已把工程「{0}」导入项目", "Imported project “{0}”"],
  "materials.addedToComp": ["已把「{0}」加到当前合成 {1} 秒", "Added “{0}” to the current comp at {1}s"],
  "materials.importFailed": ["导入失败：{0}", "Import failed: {0}"],
  "materials.noComp": ["素材已导入项目，但 AE 里没有打开的合成", "Imported into the project, but no composition is open"],
  "materials.changeRoot": ["更换素材目录", "Change media folder"],
  "materials.refreshTitle": ["刷新", "Refresh"],
  "materials.folderItems": ["{0} 项", "{0} items"],
  "materials.emptyFolder": ["这个文件夹里没有素材", "No materials in this folder"],
  "materials.back": ["返回上一级", "Back to parent folder"],
  "materials.backHint": ["双击返回上一级", "Double-click to go back"],

  /* ---------- 曲线视图 ---------- */
  "curve.aria": ["曲线编辑", "Curve editor"],
  "curve.modeTitle": ["图表：值 / 速度 / 路径", "Graph: value / speed / path"],
  "curve.modeValue": ["值", "V"],
  "curve.modeValueTitle": ["值曲线（可编辑）", "Value curve (editable)"],
  "curve.modeSpeed": ["速", "S"],
  "curve.modeSpeedTitle": ["速度曲线（只读）", "Speed curve (read-only)"],
  "curve.modePath": ["路", "P"],
  "curve.modePathTitle": ["空间路径（只读）", "Spatial path (read-only)"],
  "curve.toolbarAria": ["曲线工具", "Curve tools"],
  "curve.modeTwo": ["两点", "Two"],
  "curve.modeTwoTitle": ["两点模式：拖两端把手", "Two-point mode: drag the two handles"],
  "curve.modeMulti": ["多点", "Multi"],
  "curve.modeMultiTitle": ["多点模式：双击加点、拖节点与把手", "Multi-point mode: double-click to add nodes"],
  "curve.toolRead": ["读取", "Read"],
  "curve.toolReadTitle": ["读取选中关键帧的曲线", "Read the curve of the selected keys"],
  "curve.toolReverse": ["反向", "Reverse"],
  "curve.toolReverseTitle": ["曲线反向（只改本地）", "Reverse the curve (local only)"],
  "curve.toolSwap": ["换键", "Swap"],
  "curve.toolSwapTitle": ["交换选中的两个关键帧", "Swap the two selected keyframes"],
  "curve.toolFreezeLeft": ["冻左", "Freeze L"],
  "curve.toolFreezeLeftTitle": ["把选中区间冻结为首键的值", "Freeze at the first selected value"],
  "curve.toolFreezeRight": ["冻右", "Freeze R"],
  "curve.toolFreezeRightTitle": ["把选中区间冻结为末键的值", "Freeze at the last selected value"],
  "curve.toolSnap": ["吸附", "Snap"],
  "curve.toolSnapTitle": ["吸附到 0.1 网格", "Snap to a 0.1 grid"],
  "curve.toolUndo": ["撤销", "Undo"],
  "curve.toolUndoTitle": ["撤销本地曲线改动", "Undo the local graph edit"],
  "curve.toolRedo": ["重做", "Redo"],
  "curve.toolRedoTitle": ["重做本地曲线改动", "Redo the local graph edit"],
  "curve.toolReset": ["重置", "Reset"],
  "curve.toolResetTitle": ["恢复默认两点曲线", "Reset to the default two-node curve"],
  "curve.apply": ["应用", "Apply"],
  "curve.applyTitle": ["应用到 AE 选中关键帧", "Apply to the selected keyframes"],
  "curve.saveCurrentTitle": ["保存当前曲线为预设", "Save the current curve as a preset"],
  "curve.splitAria": ["调整曲线与预设的比例", "Resize the curve and presets panes"],
  "curve.presetsTitle": ["预设", "PRESETS"],
  "curve.scrollPrev": ["上一组工具", "Previous tools"],
  "curve.scrollNext": ["下一组工具", "More tools"],
  "curve.applying": ["应用中…", "Applying…"],
  "curve.overwrite": ["覆盖", "Overwrite"],
  "curve.discard": ["放弃", "Discard"],
  "curve.conflictAria": ["并发冲突", "Concurrent change"],
  "curve.savePresetTitle": ["保存曲线预设", "Save curve preset"],
  "curve.saveCurrent": ["保存当前", "Save current"],
  "curve.presetName": ["预设名称", "Preset name"],
  "curve.save": ["保存", "Save"],
  "curve.cancel": ["取消", "Cancel"],
  "curve.deletePresetTitle": ["删除曲线预设", "Delete curve preset"],
  "curve.delete": ["删除", "Delete"],

  /* ---------- 底栏 ---------- */
  "status.ready": ["准备扫描", "Ready"],
  "status.size": ["方块大小", "Tile size"],

  /* ---------- 设置抽屉 ---------- */
  "settings.title": ["设置", "Settings"],
  "settings.close": ["关闭设置", "Close settings"],
  "settings.library": ["库", "Library"],
  "settings.entries": ["条目", "Entries"],
  "settings.loading": ["正在读取效果库", "Loading library…"],
  "settings.appearance": ["外观", "Appearance"],
  "settings.language": ["界面语言", "Language"],
  "settings.langGroup": ["语言", "Language"],
  "settings.notes": ["使用说明", "Notes"],
  "settings.note1": [
    "在 AE 里选中图层后，双击效果卡片即可把该效果加到选中层。单击不会改动工程。悬停预览可播放动态效果，静止效果不播放。",
    "Select a layer in AE, then double-click an effect card to add it. A single click does not touch the project. Hover a card to play animated previews; static effects stay still."
  ],
  "settings.note2": [
    "面板不执行任何预览渲染。内置与插件预览都在关闭 AE 后由离线工具生成；插件参数一律保持默认。",
    "The panel never renders previews. Built-in and plugin previews are generated by offline tools after AE is closed; plugin parameters always stay at their defaults."
  ],

  /* ---------- 状态栏 / 运行消息 ---------- */
  "msg.scanning": ["正在读取效果清单…", "Reading the effect list…"],
  "msg.scanned": ["{0} 个效果 · {1} 个分类", "{0} effects · {1} categories"],
  "msg.noCatalog": ["读取失败：{0}", "Read failed: {0}"],
  "msg.noComp": ["AE 里没有打开的合成", "No composition open in AE"],
  "msg.noLayer": ["请先在 AE 里选中一个图层，再双击效果",
    "Select a layer in AE first, then double-click an effect"],
  "msg.addFailed": ["添加失败：{0}", "Add failed: {0}"],
  "msg.applied": ["已应用曲线", "Curve applied"],
  "msg.hubOpening": ["正在打开 DreamEngine Hub…", "Opening DreamEngine Hub…"],
  "msg.hubOpened": ["已打开 DreamEngine Hub", "DreamEngine Hub opened"],
  "msg.hubMissing": ["未找到 DreamEngine Hub，请先安装或启动一次 Hub",
    "DreamEngine Hub was not found. Install it or launch Hub once first."],
  "msg.unknown": ["未知原因", "unknown"],

  /* ---------- 动态消息（library.js 里以 L(key, args) 取） ---------- */
  "msg.readFail": ["读取失败：{0}", "Read failed: {0}"],
  "msg.noExtDir": ["无法取得扩展目录", "Could not resolve the extension folder"],
  "msg.emptyCatalog": ["AE catalog 返回空值", "AE catalog returned nothing"],
  /* ---------- 预设视图的提示 ---------- */
  "preset.applyHint": ["（点一下应用到当前合成）", " (click to apply to the current comp)"],
  "preset.fallbackCategory": ["预设", "Presets"],
  "preset.applied": ["已应用「{0}」（图层类型 {1}，新增效果 {2}）",
    "Applied “{0}” (layer {1}, {2} effect(s) added)"],
  "preset.notApplied": ["预设没有生效：{0}", "The preset had no effect: {0}"],
  "preset.missingPlugins": ["缺少 {0} 个插件效果：{1} 等",
    "Missing {0} plugin effect(s): {1} …"]
};

/** 取文案。lang: "zh" | "en"；args 可选，替换 {0} {1}… */
function AEV_t(key, lang, args) {
  var row = AEV_I18N[key];
  var text = row ? (lang === "en" ? row[1] : row[0]) : key;
  if (args && args.length) {
    for (var i = 0; i < args.length; i++) {
      text = text.replace("{" + i + "}", String(args[i]));
    }
  }
  return text;
}

/**
 * 把页面上所有静态文案换成指定语言。
 *
 * 四种挂载方式：
 *   data-i18n      → textContent
 *   data-i18n-title→ title
 *   data-i18n-aria → aria-label
 *   data-i18n-ph   → placeholder
 *
 * 只用 textContent，不碰 innerHTML：文案来自我们自己的表，但没必要开这个口子。
 */
function AEV_applyI18n(lang) {
  var i;
  var nodes;

  nodes = document.querySelectorAll("[data-i18n]");
  for (i = 0; i < nodes.length; i++) {
    nodes[i].textContent = AEV_t(nodes[i].getAttribute("data-i18n"), lang);
  }

  nodes = document.querySelectorAll("[data-i18n-title]");
  for (i = 0; i < nodes.length; i++) {
    nodes[i].setAttribute("title", AEV_t(nodes[i].getAttribute("data-i18n-title"), lang));
  }

  nodes = document.querySelectorAll("[data-i18n-aria]");
  for (i = 0; i < nodes.length; i++) {
    nodes[i].setAttribute("aria-label", AEV_t(nodes[i].getAttribute("data-i18n-aria"), lang));
  }

  nodes = document.querySelectorAll("[data-i18n-ph]");
  for (i = 0; i < nodes.length; i++) {
    nodes[i].setAttribute("placeholder", AEV_t(nodes[i].getAttribute("data-i18n-ph"), lang));
  }

  try {
    document.documentElement.setAttribute("lang", lang === "en" ? "en" : "zh-CN");
  } catch (e) {}
}
