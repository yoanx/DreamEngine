/* ============================================================
 * sticky_shadow.js —— 吸顶头部滚动时加投影
 *
 * 素材页的路径栏是 position:sticky（见 style.css 的 .materials-head）。
 * 只有内容真的从它下方滑过时，才需要「浮起来」的视觉暗示；
 * 静止时加投影会在面板顶部凭空多一条暗带，所以由滚动状态驱动。
 *
 * 判定阈值取 2px 而不是 0：滚轮/触控板会产生 0~1px 的抖动，
 * 用 0 会让投影在临界点上闪烁。
 *
 * 只用 ES5 + 原生事件：跑在 CEP 11（Chromium 74）里，没有可选链之类。
 * ============================================================ */

var AEV_StickyShadow = (function () {
  "use strict";

  var THRESHOLD = 2;

  /** 给某个滚动容器绑一个「滚动了就给头部挂 .is-stuck」的监听 */
  function bind(scroller, head) {
    var stuck = false;

    function sync() {
      var next = scroller.scrollTop > THRESHOLD;
      if (next === stuck) return;
      stuck = next;
      if (next) {
        head.classList.add("is-stuck");
      } else {
        head.classList.remove("is-stuck");
      }
    }

    scroller.addEventListener("scroll", sync, { passive: true });
    sync();
    return sync;
  }

  function init() {
    var scroller = document.querySelector(".materials-main");
    if (!scroller) return;
    var head = scroller.querySelector(".materials-head");
    if (!head) return;
    bind(scroller, head);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { bind: bind, init: init };
})();
