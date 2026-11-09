const test = require("node:test");
const assert = require("node:assert/strict");

const { runningReason } = require("../core/ae_jobs");

function running(value) {
  return { isRunning: () => value };
}

test("runningReason: 任何 AE 子任务占用时都返回明确原因", () => {
  assert.equal(runningReason({}), "");
  assert.equal(runningReason({ preset: running(true) }), "preset_render_running");
  assert.equal(runningReason({ effects: running(true) }), "effect_render_running");
  assert.equal(runningReason({ dump: running(true) }), "param_dump_running");
  assert.equal(runningReason({ manual: running(true) }), "manual_running");
});

test("runningReason: 已结束的任务不阻止新任务", () => {
  assert.equal(
    runningReason({
      preset: running(false),
      effects: running(false),
      dump: running(false),
      manual: running(false),
    }),
    "",
  );
});
