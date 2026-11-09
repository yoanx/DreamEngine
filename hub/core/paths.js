/* ============================================================
 * paths.js —— 全项目唯一的路径定义
 *
 * 这里的每个常量都必须和另外两处**完全一致**：
 *   · tools/generate_plugin_presets.ps1（离线渲染脚本）
 *   · cep/com.dreamengine.panel/engine/store.jsx（面板数据层）
 * 三边不一致的后果是「Hub 导入了，面板看不见」这类最难查的问题。
 *
 * 不依赖 electron：可以脱离 GUI 单独跑（tools/test-hub.mjs 就是这么测的）。
 * ============================================================ */

const path = require("node:path");
const os = require("node:os");

/**
 * @param {{docsDir?: string, appData?: string}} [opts]
 */
function createPaths(opts = {}) {
  const docsDir = opts.docsDir || path.join(os.homedir(), "Documents");
  const appData =
    opts.appData || process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");

  const extDir = path.join(appData, "Adobe", "CEP", "extensions", "com.dreamengine.panel");
  const userRoot = path.join(docsDir, "DreamEngine");
  const probe = path.join(docsDir, "DreamEngineProbe");
  const dataDir = path.join(extDir, "data");

  return {
    docsDir,
    appData,
    extDir,
    dataDir,
    userRoot,

    /* 用户资产：升级安装时绝不能被覆盖（install_dreamengine.ps1 也认这两个目录） */
    presets: path.join(userRoot, "presets"),
    backgrounds: path.join(userRoot, "backgrounds"),
    presetCategories: path.join(userRoot, "preset_categories.json"),
    /* 效果库收藏：按 matchName 持久化，升级安装同样不能清空 */
    effectFavorites: path.join(userRoot, "effect_favorites.json"),

    /* 效果手动调参：用户覆盖表与 .ffx 兜底预设（升级安装不得清空） */
    effectOverrides: path.join(userRoot, "effect_overrides.tsv"),
    effectPresets: path.join(userRoot, "effect_presets"),

    /* 属性缓存：按 插件+分类 分组的 TSV 与 index.json（人工调参的参数树来源，升级安装不得清空） */
    effectParamsRoot: path.join(userRoot, "effect_params"),

    /* 离线渲染的约定目录 */
    probe,
    hubState: path.join(probe, "hub_state.json"),
    runLog: path.join(probe, "preset_plugin_run.log"),
    entries: path.join(probe, "preset_plugin_previews.tsv"),
    todo: path.join(probe, "next_preset_plugin_batch.tsv"),
    pluginEffectState: path.join(probe, "plugin_effect_state.json"),
    pluginEffectLog: path.join(probe, "plugin_run.log"),

    /* 预览渲染：逐条结果（一次运行一份，Hub 启动时清空并写入 skip 行） */
    previewResults: path.join(probe, "preview_run_results.tsv"),

    /* 批量取参：目标清单、状态、黑名单与原始 dump（与 tools/dump_plugin_effect_params.ps1 一致） */
    effectDumpTargets: path.join(probe, "next_effect_dump.tsv"),
    effectDumpState: path.join(probe, "effect_dump_state.json"),
    effectDumpLog: path.join(probe, "effect_dump.log"),
    effectDumpBlacklist: path.join(probe, "effect_dump_blacklist.tsv"),
    effectParamsRaw: path.join(probe, "effect_params_raw"),

    /* AE 崩溃修复对话框看守日志（Hub 调起 AE 时由 tools/ae_crash_guard.ps1 追加写） */
    aeGuardLog: path.join(probe, "ae_guard.log"),

    /* 选择性渲染：目录扫描与选择文件（与 tools/*.ps1、*.jsx 保持一致） */
    pluginCatalog: path.join(probe, "plugin_effect_catalog.tsv"),
    pluginCatalogMeta: path.join(probe, "plugin_effect_catalog.meta.json"),
    presetCatalog: path.join(probe, "preset_catalog.json"),
    pluginSelection: path.join(probe, "next_plugin_batch.tsv"),
    presetSelection: path.join(probe, "next_preset_selection.tsv"),
    pluginSelectionMarker: path.join(probe, "plugin_selection.enabled"),
    pluginForceMarker: path.join(probe, "plugin_force.enabled"),
    pluginCatalogOnlyMarker: path.join(probe, "plugin_catalog_only.enabled"),

    /* 面板读的三份索引 */
    presetManifest: path.join(dataDir, "preset_manifest.json"),
    presetPluginManifest: path.join(dataDir, "preset_plugin_manifest.json"),
    pluginManifest: path.join(dataDir, "plugin_manifest.json"),

    /* 效果库的内置预览索引：面板写入的 L1 manifest.json（8×8 拼图） */
    builtinManifest: path.join(dataDir, "manifest.json"),
    manifestXml: path.join(extDir, "CSXS", "manifest.xml"),
  };
}

module.exports = { createPaths };
