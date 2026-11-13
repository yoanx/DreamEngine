const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const presetSources = require("../../hub/core/preset_sources");
const presets = require("../../hub/core/presets");
const { createPaths } = require("../../hub/core/paths");

function makeEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-preset-src-"));
  const docs = path.join(root, "docs");
  const appData = path.join(root, "appdata");
  const install = path.join(root, "Adobe After Effects 2025");
  const support = path.join(install, "Support Files");
  const exe = path.join(support, "AfterFX.exe");
  fs.mkdirSync(path.join(support, "Presets", "Trapcode Tao"), { recursive: true });
  fs.mkdirSync(path.join(support, "Presets", "Red Giant Mir 3"), { recursive: true });
  fs.mkdirSync(path.join(docs, "Adobe", "After Effects 2025", "User Presets"), { recursive: true });
  fs.mkdirSync(path.join(appData, "Adobe", "CEP", "extensions", "com.dreamengine.panel", "data"), {
    recursive: true,
  });
  fs.writeFileSync(exe, "fake", "utf8");
  fs.writeFileSync(path.join(support, "Presets", "Trapcode Tao", "a.ffx"), "x", "utf8");
  fs.writeFileSync(path.join(support, "Presets", "Red Giant Mir 3", "b.ffx"), "x", "utf8");
  fs.writeFileSync(path.join(support, "Presets", "Top.ffx"), "x", "utf8");
  fs.writeFileSync(
    path.join(docs, "Adobe", "After Effects 2025", "User Presets", "u.ffx"),
    "x",
    "utf8",
  );
  const paths = createPaths({ docsDir: docs, appData });
  return { root, docs, appData, install, exe, paths };
}

test("scanAePresets: 安装 Presets + User Presets 全部索引，不复制", () => {
  const env = makeEnv();
  const result = presetSources.scanAePresets(env.paths, { aeExe: env.exe, force: true });
  assert.equal(result.ok, true);
  assert.equal(result.count, 4);
  assert.equal(result.aeMajor, 2025);
  assert.ok(fs.existsSync(env.paths.presetCatalog));

  const sources = new Set(result.items.map((item) => item.source));
  assert.ok(sources.has("Trapcode Tao"));
  assert.ok(sources.has("Red Giant Mir 3"));
  assert.ok(sources.has("AE 内置"));
  assert.ok(sources.has("用户预设"));
  assert.ok(!fs.existsSync(path.join(env.paths.presets, "a.ffx")), "不能复制文件进预设库");
});

test("scanAePresets: 同 AE + 10 分钟内返回缓存", () => {
  const env = makeEnv();
  const first = presetSources.scanAePresets(env.paths, { aeExe: env.exe, force: true });
  const second = presetSources.scanAePresets(env.paths, { aeExe: env.exe });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.count, first.count);
});

test("presets.list: 合并外部预设，即使 DreamEngine 预设库为空", () => {
  const env = makeEnv();
  const scan = presetSources.scanAePresets(env.paths, { aeExe: env.exe, force: true });
  const listed = presets.list(env.paths);
  assert.equal(listed.exists, true);
  assert.equal(listed.items.length, scan.count);
  assert.equal(listed.externalCount, scan.count);
  const sample = listed.items.find((item) => item.fileName === "a.ffx");
  assert.equal(sample.external, true);
  assert.equal(sample.source, "Trapcode Tao");
  assert.equal(sample.rendered, false);
});

test("presets.list: 默认预设跨 AE 版本同名时复用预览", () => {
  const env = makeEnv();
  const current = path.join(env.install, "Support Files", "Presets", "Text", "同名预设.ffx");
  fs.mkdirSync(path.dirname(current), { recursive: true });
  fs.writeFileSync(current, "x", "utf8");
  fs.writeFileSync(
    env.paths.presetPluginManifest,
    JSON.stringify({
      version: 1,
      items: [
        {
          name: "同名预设",
          path: path.join(
            env.root,
            "Adobe After Effects 2023",
            "Support Files",
            "Presets",
            "Text",
            "同名预设.ffx",
          ).replace(/\\/g, "/"),
          src: "thumbs/preset_001_0000.png",
          stillSrc: "thumbs/preset_001_0003.png",
          frames: 6,
          animated: true,
          fps: 24,
        },
      ],
    }),
    "utf8",
  );

  presetSources.scanAePresets(env.paths, { aeExe: env.exe, force: true });
  const listed = presets.list(env.paths);
  const item = listed.items.find((preset) => preset.name === "同名预设");

  assert.equal(item.rendered, true);
  assert.equal(item.frames, 6);
  assert.equal(item.thumb, path.join(env.paths.dataDir, "thumbs/preset_001_0003.png"));
});

test("presets.list: 默认预设的精确路径预览优先于同名回退", () => {
  const env = makeEnv();
  const current = path.join(env.install, "Support Files", "Presets", "Text", "同名预设.ffx");
  fs.mkdirSync(path.dirname(current), { recursive: true });
  fs.writeFileSync(current, "x", "utf8");
  fs.writeFileSync(
    env.paths.presetPluginManifest,
    JSON.stringify({
      version: 1,
      items: [
        {
          name: "同名预设",
          path: path.join(
            env.root,
            "Adobe After Effects 2023",
            "Support Files",
            "Presets",
            "Text",
            "同名预设.ffx",
          ).replace(/\\/g, "/"),
          src: "thumbs/preset_001_0000.png",
          frames: 6,
        },
        {
          name: "同名预设",
          path: current.replace(/\\/g, "/"),
          src: "thumbs/preset_002_0000.png",
          frames: 2,
        },
      ],
    }),
    "utf8",
  );

  presetSources.scanAePresets(env.paths, { aeExe: env.exe, force: true });
  const item = presets
    .list(env.paths)
    .items.find(
      (preset) =>
        preset.path.toLowerCase() === current.replace(/\\/g, "/").toLowerCase(),
    );

  assert.equal(item.rendered, true);
  assert.equal(item.frames, 2);
  assert.equal(item.thumb, path.join(env.paths.dataDir, "thumbs/preset_002_0001.png"));
});

test("presets.list: 用户预设不能借用默认预设的同名预览", () => {
  const env = makeEnv();
  const userPreset = path.join(
    env.docs,
    "Adobe",
    "After Effects 2025",
    "User Presets",
    "同名预设.ffx",
  );
  fs.writeFileSync(userPreset, "x", "utf8");
  fs.writeFileSync(
    env.paths.presetPluginManifest,
    JSON.stringify({
      version: 1,
      items: [
        {
          name: "同名预设",
          path: path.join(
            env.root,
            "Adobe After Effects 2023",
            "Support Files",
            "Presets",
            "Text",
            "同名预设.ffx",
          ).replace(/\\/g, "/"),
          src: "thumbs/preset_001_0000.png",
          frames: 6,
        },
      ],
    }),
    "utf8",
  );

  presetSources.scanAePresets(env.paths, { aeExe: env.exe, force: true });
  const item = presets
    .list(env.paths)
    .items.find(
      (preset) =>
        preset.path.toLowerCase() === userPreset.replace(/\\/g, "/").toLowerCase(),
    );

  assert.equal(item.rendered, false);
});

test("presets.resolveSelection: 允许外部目录索引中的 .ffx，拒绝未知路径", () => {
  const env = makeEnv();
  presetSources.scanAePresets(env.paths, { aeExe: env.exe, force: true });
  const a = path.join(env.install, "Support Files", "Presets", "Trapcode Tao", "a.ffx");
  const user = path.join(env.docs, "Adobe", "After Effects 2025", "User Presets", "u.ffx");
  const outside = path.join(env.root, "Outside.ffx");
  fs.writeFileSync(outside, "x", "utf8");
  const selected = presets.resolveSelection(env.paths, [a, user, outside, a]);
  assert.deepEqual(selected, [a, user]);
});
