/* ============================================================
 * effect_overrides.js 纯逻辑断言
 *
 * 全部在临时目录里跑，不读写真实 Documents / %APPDATA%：
 *   · 缺失 / 空 / 损坏表退化为空覆盖，不阻塞渲染
 *   · 合法行解析（number / boolean / array / preset-only）
 *   · 非法行逐行跳过并记录错误
 *   · preset 路径限制在 effect_presets/，拒绝 ../、盘符、绝对路径
 *   · 写入前全量校验；原子替换并留 .bak
 *   · .ffx 导入不覆盖同名文件
 *
 * 运行：npm test（或 node --test test/effect_overrides.test.js）
 * ============================================================ */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const overrides = require("../core/effect_overrides");
const { createPaths } = require("../core/paths");

const HEADER = overrides.HEADER.join("\t");

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-overrides-"));
  const docs = path.join(root, "docs");
  const appData = path.join(root, "appdata");
  const paths = createPaths({ docsDir: docs, appData });
  fs.mkdirSync(paths.userRoot, { recursive: true });
  fs.mkdirSync(paths.effectPresets, { recursive: true });
  return { root, paths };
}

function writePreset(paths, name, content = "ffx") {
  const file = path.join(paths.effectPresets, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

test("缺失表：返回空覆盖，不报错", () => {
  const { paths } = makeWorkspace();
  const result = overrides.read(paths);
  assert.equal(result.ok, true);
  assert.equal(result.missing, true);
  assert.deepEqual(result.items, []);
  assert.equal(result.file, paths.effectOverrides);
});

test("写入 / 读取：number、boolean、array、preset-only 与 .bak", () => {
  const { paths } = makeWorkspace();
  writePreset(paths, "bcc_glow.ffx");

  const items = [
    {
      matchName: "Videocopilot Twitch",
      preset: "",
      scene: "",
      enabled: true,
      paramIndex: "4",
      paramPath: "Enable → Blur",
      value: 1,
      valueType: "number",
      verified: true,
      note: "P0",
    },
    {
      matchName: "BCC_GLOW",
      preset: "bcc_glow.ffx",
      scene: "footage-2d",
      enabled: true,
      paramIndex: "",
      value: null,
      valueType: "",
      verified: false,
      note: "BCC+ writes ignored",
    },
    {
      matchName: "S_Glow",
      preset: "",
      scene: "footage-2d",
      enabled: true,
      paramIndex: "12.3",
      paramPath: "Glow",
      value: [0.9, 0.3, 0.2],
      valueType: "array",
      verified: null,
      note: "",
    },
    {
      matchName: "S_Glow",
      preset: "",
      scene: "",
      enabled: false,
      paramIndex: "13",
      value: true,
      valueType: "boolean",
      verified: true,
      note: "disabled",
    },
  ];

  const written = overrides.write(paths, items);
  assert.equal(written.ok, true);
  assert.equal(fs.existsSync(paths.effectOverrides), true);

  const text = fs.readFileSync(paths.effectOverrides, "utf8");
  assert.equal(text.charCodeAt(0), HEADER.charCodeAt(0));
  assert.ok(text.includes("\r\n"));
  assert.ok(text.startsWith(HEADER + "\r\n"));

  const read = overrides.read(paths);
  assert.equal(read.ok, true);
  assert.equal(read.missing, false);
  assert.equal(read.items.length, 4);

  const twitch = read.items[0];
  assert.equal(twitch.matchName, "Videocopilot Twitch");
  assert.equal(twitch.paramIndex, "4");
  assert.equal(twitch.value, 1);
  assert.equal(twitch.valueType, "number");
  assert.equal(twitch.verified, true);
  assert.equal(twitch.enabled, true);
  assert.equal(twitch.presetExists, false);

  const bcc = read.items[1];
  assert.equal(bcc.preset, "effect_presets/bcc_glow.ffx");
  assert.equal(bcc.value, null);
  assert.equal(bcc.valueType, "");
  assert.equal(bcc.verified, false);
  assert.equal(bcc.presetExists, true);

  const sapphire = read.items[2];
  assert.deepEqual(sapphire.value, [0.9, 0.3, 0.2]);
  assert.equal(sapphire.valueType, "array");
  assert.equal(sapphire.verified, null);

  assert.equal(read.items[3].enabled, false);
  assert.equal(read.items[3].value, true);

  /* 第二次写：旧表应留 .bak */
  const next = items.map((item) => ({ ...item }));
  next[0] = { ...next[0], value: 1, note: "updated" };
  assert.equal(overrides.write(paths, next).ok, true);
  assert.equal(fs.existsSync(paths.effectOverrides + ".bak"), true);
  assert.ok(fs.readFileSync(paths.effectOverrides + ".bak", "utf8").includes("P0"));
});

test("非法写入：全量校验失败时不落盘", () => {
  const { paths } = makeWorkspace();
  const valid = overrides.write(paths, [
    {
      matchName: "S_Glow",
      paramIndex: "12",
      value: 25,
      valueType: "number",
      enabled: true,
      verified: true,
    },
  ]);
  assert.equal(valid.ok, true);
  const before = fs.readFileSync(paths.effectOverrides, "utf8");

  const invalid = overrides.write(paths, [
    {
      matchName: "S_Glow",
      preset: "../evil.ffx",
      enabled: true,
      verified: false,
    },
  ]);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid_items");
  assert.ok(invalid.errors.some((error) => error.message === "bad_preset_path"));
  assert.equal(fs.readFileSync(paths.effectOverrides, "utf8"), before);
});

test("损坏表：bad_header 退化为空覆盖 + errors", () => {
  const { paths } = makeWorkspace();
  fs.writeFileSync(paths.effectOverrides, "not-a-header\r\nS_Glow\t\t\t1\t12\t\t25\tnumber\t1\tx\r\n", "utf8");
  const result = overrides.read(paths);
  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.deepEqual(result.items, []);
  assert.equal(result.errors[0].message, "bad_header");
});

test("非法行：逐行跳过并记录错误，合法行仍保留", () => {
  const { paths } = makeWorkspace();
  const lines = [
    HEADER,
    "S_Glow\t\tfootage-2d\t1\t12\tGlow\t25\tnumber\t1\tok",
    "\t\t\t1\t12\t\t25\tnumber\t1\tmissing name",
    "S_Glow\t../evil.ffx\t\t1\t\t\t\t\t0\tbad preset",
    "S_Glow\tC:/evil.ffx\t\t1\t\t\t\t\t0\tbad preset abs",
    "S_Glow\t\t\t1\ta\t\t25\tnumber\t1\tbad index",
    "S_Glow\t\t\t1\t12\t\t25\twat\t1\tbad type",
    "S_Glow\t\tbad-scene\t1\t12\t\t25\tnumber\t1\tbad scene",
    "S_Glow\t\t\twat\t12\t\t25\tnumber\t1\tbad enabled",
    "S_Glow\t\t\t1\t12\t\t25\tnumber\twat\tbad verified",
    "S_Glow\t\t\t1\t\t\t\t\t\tempty override",
  ];
  fs.writeFileSync(paths.effectOverrides, lines.join("\r\n") + "\r\n", "utf8");

  const result = overrides.read(paths);
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].matchName, "S_Glow");
  assert.equal(result.items[0].value, 25);
  assert.equal(result.errors.length, 9);
  const messages = result.errors.map((error) => error.message);
  assert.ok(messages.includes("missing_match_name"));
  assert.ok(messages.includes("bad_preset_path"));
  assert.ok(messages.includes("bad_param_index"));
  assert.ok(messages.includes("bad_value_type"));
  assert.ok(messages.includes("bad_scene"));
  assert.ok(messages.includes("bad_enabled"));
  assert.ok(messages.includes("bad_verified"));
  assert.ok(messages.includes("empty_override"));
});

test("preset 路径：限制在 effect_presets/，拒绝越界", () => {
  const { paths } = makeWorkspace();
  assert.equal(overrides.normalizePreset(""), "");
  assert.equal(overrides.normalizePreset("ok.ffx"), "effect_presets/ok.ffx");
  assert.equal(overrides.normalizePreset("effect_presets/ok.ffx"), "effect_presets/ok.ffx");
  assert.equal(overrides.normalizePreset("../evil.ffx"), null);
  assert.equal(overrides.normalizePreset("C:\\evil.ffx"), null);
  assert.equal(overrides.normalizePreset("/evil.ffx"), null);
  assert.equal(overrides.normalizePreset("ok.txt"), null);

  const file = writePreset(paths, "ok.ffx");
  assert.equal(overrides.presetAbsolute(paths, "ok.ffx"), file);
  assert.equal(overrides.presetAbsolute(paths, "../evil.ffx"), "");
  assert.equal(overrides.presetExists(paths, "ok.ffx"), true);
  assert.equal(overrides.presetExists(paths, "../evil.ffx"), false);
});

test("导入 .ffx：不覆盖同名，返回相对 preset", () => {
  const { root, paths } = makeWorkspace();
  const source = path.join(root, "source.ffx");
  fs.writeFileSync(source, "first", "utf8");

  const first = overrides.importPreset(paths, source);
  assert.equal(first.ok, true);
  assert.equal(first.preset, "effect_presets/source.ffx");
  assert.equal(fs.readFileSync(first.path, "utf8"), "first");

  const second = overrides.importPreset(paths, source);
  assert.equal(second.ok, true);
  assert.equal(second.preset, "effect_presets/source-1.ffx");

  const text = path.join(root, "source.txt");
  fs.writeFileSync(text, "nope", "utf8");
  assert.equal(overrides.importPreset(paths, text).reason, "not_ffx");
  assert.equal(overrides.importPreset(paths, path.join(root, "missing.ffx")).reason, "source_missing");
});

test("签名：与行序无关，忽略 disabled", () => {
  const a = {
    matchName: "S_Glow",
    preset: "",
    scene: "footage-2d",
    enabled: true,
    paramIndex: "12",
    value: 25,
    valueType: "number",
    verified: true,
  };
  const b = {
    matchName: "S_Glow",
    preset: "",
    scene: "footage-2d",
    enabled: true,
    paramIndex: "13",
    value: true,
    valueType: "boolean",
    verified: null,
  };
  assert.equal(overrides.signature([a, b]), overrides.signature([b, a]));
  assert.equal(overrides.signature([{ ...a, enabled: false }]), "");
  assert.equal(overrides.forMatchName([a, b, { ...a, paramIndex: "14" }], "S_Glow").length, 3);
});

test("note / paramPath 的 tab 与换行会被清洗", () => {
  const { paths } = makeWorkspace();
  const result = overrides.write(paths, [
    {
      matchName: "S_Glow",
      enabled: true,
      paramIndex: "12",
      value: 25,
      valueType: "number",
      verified: true,
      note: "line1\tline2\r\nline3",
      paramPath: "a\tb",
    },
  ]);
  assert.equal(result.ok, true);
  const read = overrides.read(paths);
  assert.equal(read.items[0].note, "line1 line2 line3");
  assert.equal(read.items[0].paramPath, "a b");
});

test("manualEntry: 未提供 verified 时保持三态中的 null", () => {
  const row = overrides.manualEntry("S_Glow", {
    indexPath: "12",
    path: "颜色 / 强度",
    value: "25",
  });

  assert.equal(row.matchName, "S_Glow");
  assert.equal(row.paramIndex, "12");
  assert.equal(row.paramPath, "颜色 / 强度");
  assert.equal(row.verified, null);
  assert.equal(
    overrides.manualEntry("S_Glow", { indexPath: "12", value: "25", verified: false }).verified,
    false,
  );
});

test("manualRow: 覆盖表 item 转成渲染层调参行", () => {
  const row = overrides.manualRow({
    matchName: "S_Glow",
    preset: "",
    scene: "",
    enabled: true,
    paramIndex: "12.3",
    paramPath: "颜色 / 强度",
    value: 25,
    valueType: "number",
    verified: false,
    note: "keep me",
  });

  assert.deepEqual(row, {
    indexPath: "12.3",
    path: "颜色 / 强度",
    value: 25,
    valueType: "number",
    verified: false,
    note: "keep me",
  });
});
