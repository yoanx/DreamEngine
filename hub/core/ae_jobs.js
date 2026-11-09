/* Hub 中所有会启动 After Effects 的子任务共用一把互斥锁。 */

function runningReason(jobs) {
  const value = jobs || {};
  if (value.preset && value.preset.isRunning()) return "preset_render_running";
  if (value.effects && value.effects.isRunning()) return "effect_render_running";
  if (value.dump && value.dump.isRunning()) return "param_dump_running";
  if (value.manual && value.manual.isRunning()) return "manual_running";
  return "";
}

module.exports = { runningReason };
