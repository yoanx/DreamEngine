/* ============================================================
 * recipe.jsx 纯逻辑断言（在 Node vm 里加载 ExtendScript）
 *
 * 只验证 P0 实机结论对应的 Twitch 修复：
 *   · RECIPES 把 Enable 组后的 Blur 静态置 1
 *   · STATIC_RECIPES 让 animate() 不碰属性（P0 只验证了静态写入）
 *   · 不改 RECIPE_VERSION，避免全量内置缓存失效
 *
 * 运行：npm test（或 node --test test/recipe.test.js）
 * ============================================================ */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const RECIPE_FILE = path.join(
  __dirname,
  "..",
  "..",
  "cep",
  "com.dreamengine.panel",
  "engine",
  "recipe.jsx",
);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(RECIPE_FILE, "utf8"), sandbox, { filename: RECIPE_FILE });
const recipe = sandbox.AEV_Recipe;

function makeGroup(props) {
  return {
    numProperties: props.length,
    property(index) {
      return props[index - 1];
    },
  };
}

test("Videocopilot Twitch：静态配方把 Enable 组的 Blur 置 1", () => {
  const props = [
    { name: "Enable", numProperties: 0 },
    {
      name: "Blur",
      numProperties: 0,
      setValue(value) {
        this.value = value;
      },
    },
    {
      name: "Color",
      numProperties: 0,
      setValue(value) {
        this.value = value;
      },
    },
  ];
  const result = recipe.apply(makeGroup(props), "Videocopilot Twitch", 128);
  assert.equal(result.mode, "recipe");
  assert.equal(result.writes, 1);
  assert.equal(props[1].value, 1);
  assert.equal(props[2].value, undefined);
});

test("Videocopilot Twitch 只做静态写入，animate 不碰属性", () => {
  let touched = false;
  const group = {
    numProperties: 1,
    property() {
      touched = true;
      return { name: "Blur" };
    },
  };
  assert.equal(recipe.isStaticRecipe("Videocopilot Twitch"), true);
  assert.equal(recipe.animate(group, "Videocopilot Twitch", 0.2), false);
  assert.equal(touched, false);
});

test("配方版本不因 Twitch 修复而 bump", () => {
  assert.equal(recipe.RECIPE_VERSION, 5);
  const twitch = recipe.recipes["Videocopilot Twitch"];
  assert.equal(twitch.length, 1);
  assert.equal(twitch[0].names[0], "Blur");
  assert.equal(twitch[0].value, 1);
});

test("覆盖表：解析 number / array / boolean、scene、预设与禁用行", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-recipe-override-"));
  const dir = path.join(root, "DreamEngine");
  fs.mkdirSync(path.join(dir, "effect_presets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "effect_presets", "x.ffx"), "dummy");

  const tsv = [
    "matchName\tpreset\tscene\tenabled\tparamIndex\tparamPath\tvalue\tvalueType\tverified\tnote",
    "TestEffect\t\tadjustment\t1\t2\t强度\t25\tnumber\t1\t",
    "TestEffect\t\t\t1\t3.1\t\t[0.5,0.25,0.1]\tarray\t\t",
    "TestEffect\t\t\t1\t4\tBlur\ttrue\tboolean\t\t",
    "Disabled\t\t\t0\t1\t\t5\tnumber\t1\t",
    "PresetOnly\teffect_presets/x.ffx\tfootage-2d\t1\t\t\t\tnumber\t0\t",
  ].join("\r\n");
  fs.writeFileSync(path.join(dir, "effect_overrides.tsv"), tsv);

  // ExtendScript File/Folder 的最小替身：只覆盖覆盖表读取用到的接口。
  sandbox.Folder = { myDocuments: { fsName: root } };
  sandbox.File = class {
    constructor(filePath) {
      this.fsName = String(filePath);
      this._text = "";
    }
    get exists() {
      return fs.existsSync(this.fsName);
    }
    set encoding(_value) {}
    open(mode) {
      if (mode === "r" && !fs.existsSync(this.fsName)) return false;
      this._text = fs.existsSync(this.fsName) ? fs.readFileSync(this.fsName, "utf8") : "";
      return true;
    }
    read() {
      return this._text;
    }
    close() {}
  };

  recipe.resetOverrides();
  const ov = recipe.overrideFor("TestEffect");
  assert.ok(ov);
  assert.equal(ov.scene, "adjustment");
  assert.equal(ov.params.length, 3);
  assert.equal(ov.params[0].value, 25);
  assert.deepEqual(Array.from(ov.params[1].value), [0.5, 0.25, 0.1]);
  assert.equal(ov.params[2].value, true);
  assert.equal(recipe.sceneFor("TestEffect"), "adjustment");
  assert.ok(recipe.overrideSignatureFor("TestEffect").startsWith("ov:"));
  assert.equal(recipe.overrideFor("Disabled"), null);
  assert.equal(
    recipe.presetPathFor("PresetOnly"),
    root + "/DreamEngine/effect_presets/x.ffx",
  );
  assert.equal(recipe.apply({ numProperties: 0, property() {} }, "PresetOnly", 128).mode, "override-preset");

  const leaf2 = { name: "强度", value: 0, setValue(value) { this.value = value; } };
  const leaf31 = { name: "colors", value: [0, 0, 0], setValue(value) { this.value = value; } };
  const leaf4 = { name: "Blur", value: false, setValue(value) { this.value = value; } };
  const group31 = { numProperties: 1, property(index) { return index === 1 ? leaf31 : undefined; } };
  const group = {
    numProperties: 4,
    property(index) {
      if (index === 1) return { numProperties: 0 };
      if (index === 2) return leaf2;
      if (index === 3) return group31;
      if (index === 4) return leaf4;
      return undefined;
    },
  };

  const applied = recipe.apply(group, "TestEffect", 128);
  assert.equal(applied.mode, "override");
  assert.equal(applied.writes, 3);
  assert.equal(leaf2.value, 25);
  assert.deepEqual(Array.from(leaf31.value), [0.5, 0.25, 0.1]);
  assert.equal(leaf4.value, true);
  assert.notEqual(
    recipe.cacheKey("TestEffect", "asset", 128, 1, "ov:test"),
    recipe.cacheKey("TestEffect", "asset", 128, 1, ""),
  );

  fs.rmSync(root, { recursive: true, force: true });
});