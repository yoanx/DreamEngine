/* Hub 调度参数的单测：不启动真实 PowerShell，只验证 spawn 的参数与 mode。 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const cp = require("node:child_process");
const originalSpawn = cp.spawn;
let captured = null;
const tempRoots = [];

cp.spawn = (command, args, options) => {
  captured = { command, args, options };
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.kill = () => {};
  return proc;
};

const { PluginEffectJob } = require("../../hub/core/effect_render");
const { RenderJob } = require("../../hub/core/render");

function makePaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "de-job-"));
  tempRoots.push(root);
  const probe = path.join(root, "probe");
  fs.mkdirSync(probe, { recursive: true });
  return {
    root,
    probe,
    extDir: path.join(root, "ext"),
    docsDir: root,
    appData: root,
    pluginEffectState: path.join(probe, "plugin_effect_state.json"),
    pluginEffectLog: path.join(probe, "plugin_run.log"),
    hubState: path.join(probe, "hub_state.json"),
    runLog: path.join(probe, "preset_run.log"),
  };
}

function makeScript(paths, fileName) {
  const dir = path.join(paths.root, "tools");
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, fileName);
  fs.writeFileSync(script, "# test fixture\r\n", "utf8");
  return script;
}

function hasArg(args, name, value) {
  const index = args.indexOf(name);
  if (index < 0) return false;
  return value === undefined || args[index + 1] === value;
}

test("PluginEffectJob: catalogOnly 传 -CatalogOnly，不传 -Todo", () => {
  const paths = makePaths();
  const job = new PluginEffectJob({
    paths,
    script: makeScript(paths, "generate_plugin_effects.ps1"),
  });
  const result = job.start({ ae: "C:/AE/AfterFX.exe", catalogOnly: true, limit: 3, rounds: 4 });
  assert.equal(result.ok, true);
  assert.equal(job.getMode(), "catalog");
  assert.ok(hasArg(captured.args, "-CatalogOnly"));
  assert.ok(!captured.args.includes("-Todo"));
  assert.ok(hasArg(captured.args, "-Limit", "3"));
  assert.ok(hasArg(captured.args, "-Rounds", "4"));
  job.stopPolling();
});

test("PluginEffectJob: 选择模式传 -Todo/-Force，mode=selection", () => {
  const paths = makePaths();
  const job = new PluginEffectJob({
    paths,
    script: makeScript(paths, "generate_plugin_effects.ps1"),
  });
  job.start({ todoPath: "C:/probe/next_plugin_batch.tsv", force: true });
  assert.equal(job.getMode(), "selection");
  assert.ok(hasArg(captured.args, "-Todo", "C:/probe/next_plugin_batch.tsv"));
  assert.ok(hasArg(captured.args, "-Force"));
  job.stopPolling();
});

test("PluginEffectJob: 空 ae/background 不传参数（避免 PowerShell 吞空参数）", () => {
  const paths = makePaths();
  const job = new PluginEffectJob({
    paths,
    script: makeScript(paths, "generate_plugin_effects.ps1"),
  });
  job.start({ ae: "", background: "", catalogOnly: true });
  assert.ok(!captured.args.includes("-Ae"));
  assert.ok(!captured.args.includes("-Background"));
  assert.ok(hasArg(captured.args, "-Probe", paths.probe));
  assert.ok(hasArg(captured.args, "-Extension", paths.extDir));
  job.stopPolling();
});

test("RenderJob: 预设选择传 -PresetList/-Force", () => {
  const paths = makePaths();
  const job = new RenderJob({
    paths,
    script: makeScript(paths, "generate_plugin_presets.ps1"),
  });
  const result = job.start({ presetList: "C:/probe/next_preset_selection.tsv", force: true, limit: 2 });
  assert.equal(result.ok, true);
  assert.ok(hasArg(captured.args, "-PresetList", "C:/probe/next_preset_selection.tsv"));
  assert.ok(hasArg(captured.args, "-Force"));
  assert.ok(hasArg(captured.args, "-Limit", "2"));
  job.stopPolling();
});

test("RenderJob: 预设帧率传 -Fps，并限制为支持的四个值", () => {
  const paths = makePaths();
  const script = makeScript(paths, "generate_plugin_presets.ps1");
  const first = new RenderJob({
    paths,
    script,
  });
  first.start({ fps: 60 });
  assert.ok(hasArg(captured.args, "-Fps", "60"));
  first.stopPolling();

  const second = new RenderJob({ paths, script });
  second.start({ fps: 17 });
  assert.ok(hasArg(captured.args, "-Fps", "24"));
  second.stopPolling();
});

test.after(() => {
  cp.spawn = originalSpawn;
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
