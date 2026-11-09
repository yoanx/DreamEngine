/* ============================================================
 * preload.js —— 渲染进程能看到的全部能力，只有这一个白名单
 *
 * 渲染进程不开 nodeIntegration，所有文件与进程操作都必须经过这里。
 * 将来把 UI 迁到 Tauri / 别的壳，只需要换掉这一层的实现，
 * app.js 一行不用改（和 CEP 那边 transport 解耦是同一个思路）。
 * ============================================================ */

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("hub", {
  /* 环境快照：AE 是否运行、扩展装没装、各目录在哪 */
  snapshot: () => ipcRenderer.invoke("hub:snapshot"),
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  copyText: (text) => ipcRenderer.invoke("clipboard:writeText", text),

  /* 预设库 */
  listPresets: () => ipcRenderer.invoke("presets:list"),
  syncAePresets: (options) => ipcRenderer.invoke("presets:sync", options),
  pickPresets: () => ipcRenderer.invoke("presets:pick"),
  importPaths: (files) => ipcRenderer.invoke("presets:importPaths", files),
  deletePreset: (target) => ipcRenderer.invoke("presets:delete", target),
  renamePreset: (target, name) => ipcRenderer.invoke("presets:rename", target, name),
  clearPresetRender: (target) => ipcRenderer.invoke("presets:clearRender", target),
  loadPresetCategories: () => ipcRenderer.invoke("categories:load"),
  createPresetCategory: (name) => ipcRenderer.invoke("categories:create", name),
  renamePresetCategory: (id, name) => ipcRenderer.invoke("categories:rename", id, name),
  deletePresetCategory: (id) => ipcRenderer.invoke("categories:delete", id),
  assignPresetCategory: (target, id) => ipcRenderer.invoke("categories:assign", target, id),
  togglePresetFavorite: (target) => ipcRenderer.invoke("categories:toggleFavorite", target),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  reveal: (target) => ipcRenderer.invoke("shell:reveal", target),
  openEffectParamsDir: () => ipcRenderer.invoke("settings:openEffectParams"),
  listBackgrounds: () => ipcRenderer.invoke("backgrounds:list"),
  addBackground: () => ipcRenderer.invoke("backgrounds:add"),

  /* 效果库（内置 + 插件的合并视图，见 core/effects.js） */
  listEffects: () => ipcRenderer.invoke("effects:list"),
  toggleEffectFavorite: (matchName) => ipcRenderer.invoke("effects:toggleFavorite", matchName),
  clearEffectRender: (matchName) => ipcRenderer.invoke("effects:clearPreview", matchName),

  /* 手动调参：dump / 基线 / 验证 / 保存覆盖表 / 选择 .ffx */
  readEffectOverrides: (matchName) => ipcRenderer.invoke("manual:overrides", matchName),
  dumpEffectParams: (options) => ipcRenderer.invoke("manual:dump", options),
  baselineEffectParams: (options) => ipcRenderer.invoke("manual:baseline", options),
  verifyEffectParams: (options) => ipcRenderer.invoke("manual:verify", options),
  saveEffectOverrides: (options) => ipcRenderer.invoke("manual:save", options),
  pickEffectPreset: () => ipcRenderer.invoke("manual:pickPreset"),
  stopManualEffect: () => ipcRenderer.invoke("manual:stop"),

  /* 渲染 */
  startRender: (options) => ipcRenderer.invoke("render:start", options),
  stopRender: () => ipcRenderer.invoke("render:stop"),
  renderSnapshot: () => ipcRenderer.invoke("render:snapshot"),
  logTail: (lines) => ipcRenderer.invoke("log:tail", lines),

  /* 插件效果预览 */
  startPluginEffects: (options) => ipcRenderer.invoke("plugin-effects:start", options),
  stopPluginEffects: () => ipcRenderer.invoke("plugin-effects:stop"),
  pluginEffectsSnapshot: () => ipcRenderer.invoke("plugin-effects:snapshot"),
  logPluginEffectsTail: (lines) => ipcRenderer.invoke("plugin-effects:logTail", lines),
  /* 插件效果目录（选择性渲染） */
  pluginEffectsCatalog: () => ipcRenderer.invoke("plugin-effects:catalog"),
  scanPluginEffects: (options) => ipcRenderer.invoke("plugin-effects:scan", options),

  /* 预览渲染的逐条结果（第 5 步统计与「重试失败项」的唯一数据源） */
  getPreviewResults: () => ipcRenderer.invoke("preview:results"),
  clearPreviewResults: () => ipcRenderer.invoke("preview:clearResults"),

  /* 人工调参 · 属性获取（批量脚本 + 状态轮询，见 core/effect_dump.js） */
  startEffectDump: (options) => ipcRenderer.invoke("dump:start", options),
  stopEffectDump: () => ipcRenderer.invoke("dump:stop"),
  dumpSnapshot: () => ipcRenderer.invoke("dump:snapshot"),
  logDumpTail: (lines) => ipcRenderer.invoke("dump:logTail", lines),

  /* 人工调参 · 属性缓存（只读；写入只在批量获取时由脚本产生） */
  getParamIndex: () => ipcRenderer.invoke("params:index"),
  getEffectParams: (matchName) => ipcRenderer.invoke("params:effect", matchName),

  /* 人工调参 · 覆盖表增量写（只替换该效果的行） */
  writeEffectOverrides: (payload) => ipcRenderer.invoke("overrides:write", payload),

  /* 主进程推送 */
  onRenderState: (callback) => {
    ipcRenderer.on("render:state", (_event, state) => callback(state));
  },
  onRenderExit: (callback) => {
    ipcRenderer.on("render:exit", (_event, info) => callback(info));
  },
  onPluginEffectsState: (callback) => {
    ipcRenderer.on("plugin-effects:state", (_event, state) => callback(state));
  },
  onPluginEffectsExit: (callback) => {
    ipcRenderer.on("plugin-effects:exit", (_event, info) => callback(info));
  },
  onPluginEffectsCatalog: (callback) => {
    ipcRenderer.on("plugin-effects:catalog", (_event, doc) => callback(doc));
  },
  onEffectDumpState: (callback) => {
    ipcRenderer.on("dump:state", (_event, state) => callback(state));
  },
  onEffectDumpExit: (callback) => {
    ipcRenderer.on("dump:exit", (_event, info) => callback(info));
  },
});
