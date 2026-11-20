/* ============================================================
 * compat.js —— 内核能力补丁标记（必须在 <head> 里、早于 body 渲染）
 *
 * 目前只解决一件事：flex 容器的 gap。
 *
 * 为什么不能用 @supports：
 *   Chromium 74（AE 2021 / CEP 11）的 flex gap 不生效，
 *   但 CSS.supports("gap", "8px") 返回 true —— 因为 gap 是合法属性，
 *   @supports 只看语法不看上下文。T0_9 探针实测：gap:8px 的两个子项
 *   间距是 0，而 CSS.supports 说支持。所以只能运行时量一次。
 *
 * 量出来后给 <html> 打上 .no-flex-gap，style.css 末尾的兜底规则才会生效；
 * 现代内核不打这个类，一行兜底都不会命中。
 *
 * 只用 ES5：CEP 11 不支持箭头函数/模板字符串之外的很多东西，
 * 而这个文件跑在所有脚本之前，坏掉会导致整块兜底失效。
 * ============================================================ */

(function () {
  "use strict";

  var PROBE_GAP = 16;
  var PROBE_CHILD = 10;

  /** 真测一次 flex gap：两个定宽子项之间应当差 PROBE_CHILD + PROBE_GAP */
  function flexGapWorks() {
    var box = document.createElement("div");
    box.style.cssText =
      "position:absolute;left:-9999px;top:0;display:flex;width:200px;" +
      "gap:" + PROBE_GAP + "px;";

    var a = document.createElement("div");
    var b = document.createElement("div");
    a.style.cssText = "width:" + PROBE_CHILD + "px;height:10px;";
    b.style.cssText = "width:" + PROBE_CHILD + "px;height:10px;";
    box.appendChild(a);
    box.appendChild(b);

    /* 挂在 documentElement 而不是 body：本文件在 <head> 执行，body 还不存在 */
    document.documentElement.appendChild(box);

    var delta = b.getBoundingClientRect().left - a.getBoundingClientRect().left;
    document.documentElement.removeChild(box);

    /* 用容差比较：子像素/缩放不该影响判定 */
    return Math.abs(delta - (PROBE_CHILD + PROBE_GAP)) < 0.5;
  }

  try {
    if (!flexGapWorks()) {
      document.documentElement.className += " no-flex-gap";
    }
  } catch (e) {
    /* 探测失败时按「不支持」处理：兜底最多是多一点间距，比挤在一起好 */
    document.documentElement.className += " no-flex-gap";
  }
})();
