// ============================================================
// render_config.jsx —— 定版渲染参数的扩展内副本
//
// 来源：config/render_params.jsxinc（M0 T0.9 定版，2026-11-03）
// 为什么要副本：CEP 扩展目录（cep/com.dreamengine.panel/）在装机后是
// 独立分发的，拿不到仓库根的 config/ 目录。engine 侧必须能自包含读取。
// 数值一致性由 tools/test-engine.mjs 强制校验，改一处必须同步另一处。
//
// 语法：ES3 only。
// ============================================================

var DREAM_ENGINE_RENDER_CONFIG = {
    version: 1,
    contactSheet: {
        columns: 2,
        cellSize: 720,
        width: 1440,
        height: 1440,
        effectsPerSheet: 4
    },
    animatedPreview: {
        frameCount: 24,
        fps: 24
    },
    l1: {
        totalEffects: 80,
        staticEffects: 60,
        animatedEffects: 20
    },
    render: {
        aerenderConcurrency: 1,
        skipExistingFiles: true,
        pngOutputTemplate: "DreamEngine PNG Sequence"
    },
    cef: {
        webglMaxTextureSize: 16384,
        canvasTestedMax: 8192,
        png: true,
        gif: true,
        webp: true,
        mp4Likely: true
    },
    legacyAE: {
        dropdownTextApi: false,
        minMaxReadable: true,
        unitsReadable: true
    },
    presetLibrary: {
        fileMultiSelect: true,
        dragPath: true,
        recursiveScan: true,
        recursiveScanSampleMs: 742
    }
};
