/* ============================================================
 * recipe.jsx 纯逻辑断言（在 Node vm 里加载 ExtendScript）
 *
 * 验证预览配方与 P0 实机结论对应的 Twitch 修复：
 *   · RECIPES 把 Enable 组后的 Blur 静态置 1
 *   · STATIC_RECIPES 让 animate() 不碰属性（P0 只验证了静态写入）
 *   · 内置效果配方变化时检查缓存版本已更新
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

test("新内置效果配方使用已采集的 AE 参数名", () => {
  assert.equal(recipe.RECIPE_VERSION, 13);
  const twitch = recipe.recipes["Videocopilot Twitch"];
  assert.equal(twitch.length, 1);
  assert.equal(twitch[0].names[0], "Blur");
  assert.equal(twitch[0].value, 1);

  for (const [matchName, expected] of Object.entries({
    "ADBE Fractal Noise": ["对比度", "缩放", "复杂度"],
    "ADBE Lens Flare": ["光晕亮度", "镜头类型", "与原始图像混合"],
    "ADBE Optics Compensation": ["视场 (FOV)", "反转镜头扭曲"],
    "ADBE Posterize Time": ["帧速率"],
    "ADBE Vibrance": ["自然饱和度", "饱和度"],
    "ADBE Invert": ["与原始图像混合"],
    "ADBE Tritone": ["与原始图像混合"],
    "ADBE Magnify": ["放大率", "大小"],
    "ADBE Posterize": ["级别"],
    "ADBE Median": ["半径"],
    "ADBE Bevel Edges": ["边缘厚度", "灯光强度"],
    "ADBE Bilateral": ["半径", "阈值", "彩色化"],
    "ADBE Dust & Scratches": ["半径", "阈值"],
    "ADBE Noise HLS Auto2": ["杂色", "亮度", "颗粒大小"],
    "ADBE Spherize": ["半径"],
    "ADBE Noise2": ["杂色数量", "杂色类型"],
    "CC Bubbles": ["Bubble Amount", "Bubble Speed", "Wobble Amplitude", "Bubble Size"],
    "ADBE Scatter": ["散布数量", "颗粒", "散布随机性"],
    "ADBE Smart Blur": ["半径", "阈值"],
    "ADBE Equalize": ["色调均化量"],
    "ADBE Emboss": ["起伏", "对比度", "与原始图像混合"],
    "ADBE Color Emboss": ["起伏", "对比度", "与原始图像混合"],
    "ADBE Block Dissolve": ["过渡完成", "块宽度", "块高度"],
    "ADBE Linear Wipe": ["过渡完成", "羽化"],
    "ADBE Radial Wipe": ["过渡完成", "羽化"],
    "ADBE Venetian Blinds": ["过渡完成", "宽度", "羽化"],
    "CC Jaws": ["Completion", "Height", "Width"],
    "CC Light Wipe": ["Completion", "Intensity", "Color from Source"],
    "CC Ball Action": ["Scatter", "Grid Spacing", "Ball Size"],
    "CC Pixel Polly": ["Force", "Gravity", "Grid Spacing", "Direction Randomness"],
    "CC Mr. Mercury": ["Birth Rate", "Velocity", "Longevity (sec)", "Gravity", "Blob Birth Size", "Blob Death Size"],
    "APC Foam": ["产生速率", "大小", "初始速度", "湍流", "摇摆量"],
    "CC Particle World": ["Birth Rate", "Longevity (sec)", "Velocity", "Gravity", "Scatter", "Max Opacity"],
    "CC Particle Systems II": ["Birth Rate", "Longevity (sec)", "Velocity", "Gravity", "Max Opacity"],
  })) {
    assert.deepEqual(Array.from(recipe.recipes[matchName], (step) => step.names[0]), expected);
  }
  assert.equal(recipe.isStaticRecipe("ADBE Posterize Time"), true);
  assert.equal(recipe.isStaticRecipe("ADBE Noise HLS Auto2"), true);
  assert.equal(recipe.isStaticRecipe("CC Particle World"), true);
  assert.equal(recipe.isStaticRecipe("CC Particle Systems II"), true);
  assert.equal(recipe.recipes["ADBE Lens Flare"][0].value, 110);
  assert.equal(recipe.recipes["ADBE Optics Compensation"][0].value, 24);
  assert.equal(recipe.recipes["CC Light Rays"][0].value, 85);
  assert.equal(recipe.recipes["CC Star Burst"][0].value, 110);
  assert.equal(recipe.recipes["ADBE Vibrance"][0].value, 12);
  assert.equal(recipe.recipes["ADBE Magnify"][0].value, 125);
  assert.equal(recipe.recipes["ADBE Posterize"][0].value, 16);
  assert.equal(recipe.recipes["ADBE Median"][0].value, 2);
  assert.equal(recipe.recipes["CC Scatterize"][0].value, 60);
  assert.equal(recipe.recipes["CC Bubbles"][0].value, 110);
  assert.equal(recipe.recipes["ADBE Linear Wipe"][0].value, 50);
  assert.equal(recipe.recipes["ADBE Emboss"][2].value, 0);
  assert.equal(recipe.recipes["ADBE Bevel Edges"][0].value, 0.18);
  assert.equal(recipe.recipes["ADBE Bilateral"][1].value, 5);
  assert.equal(recipe.recipes["ADBE Dust & Scratches"][0].value, 4);
  assert.equal(recipe.recipes["ADBE Noise HLS Auto2"][0].value, 3);
  assert.equal(recipe.recipes["ADBE Noise HLS Auto2"][1].value, 350);
});

test("只把内置效果的原图混合控件设为 0", () => {
  const blend = { name: "Blend With Original", numProperties: 0, setValue(value) { this.value = value; } };
  const other = { name: "Contrast", numProperties: 0, setValue(value) { this.value = value; } };
  const group = makeGroup([blend, other]);
  assert.equal(recipe.disableOriginalMix(group, "CC Star Burst"), 1);
  assert.equal(blend.value, 0);
  assert.equal(other.value, undefined);

  const pluginBlend = { name: "Blend With Original", numProperties: 0, setValue(value) { this.value = value; } };
  assert.equal(recipe.disableOriginalMix(makeGroup([pluginBlend]), "S_Glow"), 0);
  assert.equal(pluginBlend.value, undefined);
});

test("Sapphire Transitions 使用两层输入并只开启 Auto Trans", () => {
  assert.equal(recipe.sceneFor("S_Dissolve", "Sapphire Transitions"), "two-layer-input");
  assert.equal(recipe.sceneFor("S_Glow", "Sapphire Lighting"), "footage-2d");
  assert.equal(recipe.isSapphireTransition("S_WipeCircle", "Sapphire Transitions"), true);
  assert.equal(recipe.isSapphireTransition("S_Glow", "Sapphire Lighting"), false);

  const writes = [];
  const auto = {
    name: "Auto Trans",
    numProperties: 0,
    hasMin: true,
    minValue: 1,
    hasMax: true,
    maxValue: 2,
    value: 1,
    setValue(value) {
      this.value = value;
      writes.push(value);
    },
  };
  const percent = {
    name: "Dissolve Percent",
    numProperties: 0,
    value: 0,
    setValue(value) {
      writes.push(value);
    },
  };

  assert.equal(recipe.enableAutoTrans(makeGroup([auto, percent])), true);
  assert.equal(auto.value, 2);
  assert.deepEqual(writes, [2], "不能顺手写 Dissolve Percent");
});

test("Sapphire 场景分类和 Auto Trans 已接入效果渲染", () => {
  const previewgen = fs.readFileSync(
    path.join(__dirname, "..", "..", "cep", "com.dreamengine.panel", "engine", "previewgen.jsx"),
    "utf8",
  );
  assert.match(previewgen, /var category = categoryForMatchName\(matchName\)/);
  assert.match(
    previewgen,
    /layout = AEV_Recipe\.layoutFor\(AEV_Recipe\.sceneFor\(matchName, category\)\)/,
  );
  assert.match(previewgen, /AEV_Recipe\.enableAutoTrans\(effectGroup\)/);
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
