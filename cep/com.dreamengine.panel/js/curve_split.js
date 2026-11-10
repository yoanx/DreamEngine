/* ============================================================
 * curve_split.js —— 曲线页的分隔条
 *
 * 参考 XLFlow：编辑区与预设区之间一条 6px 的分隔条，
 * 面板狭长时上下拖，宽屏时左右拖；比例记在 localStorage 里。
 * 画布本身靠 curve.js 的 ResizeObserver 跟着重排，这里不用管重绘。
 * ============================================================ */

var AEV_CurveSplit = (function () {
  var KEY = "dreamengine.curve.split.v1";
  var MIN_EDITOR = 118;
  var MIN_PRESETS = 44;

  var st = {
    el: {},
    ratio: { col: 0.62, row: 0.66 },
    dragging: false,
    wide: false,
    startPos: 0,
    startSize: 0
  };

  function load() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return;
      var obj = JSON.parse(raw);
      if (obj && typeof obj.col === "number") st.ratio.col = obj.col;
      if (obj && typeof obj.row === "number") st.ratio.row = obj.row;
    } catch (e) {}
  }

  function save() {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(st.ratio));
    } catch (e) {}
  }

  function isWide() {
    if (!st.el.split) return false;
    try {
      return window.getComputedStyle(st.el.split).flexDirection === "row";
    } catch (e) {
      return false;
    }
  }

  function available() {
    var el = st.el.split;
    if (!el) return 0;
    var total = st.wide ? el.clientWidth : el.clientHeight;
    /* 扣掉分隔条自身占的位置与 1px 边框，避免永远差一点、出现滚动条 */
    return Math.max(0, total - 7);
  }

  function apply(ratio) {
    if (!st.el.editor || !st.el.presets) return;
    var total = available();
    if (total <= 0) return;
    var want = Math.round(total * ratio);
    var maxEditor = Math.max(MIN_EDITOR, total - MIN_PRESETS);
    var size = Math.min(Math.max(want, MIN_EDITOR), maxEditor);

    applySizes(size, total);
  }

  /**
   * 窄屏：编辑器吸收剩余高度，预设区按内容高度自适应并受最大高度限制。
   * 宽屏：保持原来的左右固定比例布局。
   */
  function applySizes(size, total) {
    var presetsSize = total - size;
    if (st.wide) {
      st.el.editor.style.flex = "0 0 " + size + "px";
      st.el.presets.style.flex = "1 1 auto";
      st.el.presets.style.maxHeight = "";
    } else {
      st.el.editor.style.flex = "1 1 auto";
      st.el.presets.style.flex = "0 1 auto";
      st.el.presets.style.maxHeight = Math.max(MIN_PRESETS, presetsSize) + "px";
    }
    /* 空间实在不够时把预设区收起来，而不是让画布被挤成一条线 */
    st.el.presets.style.display = presetsSize < MIN_PRESETS - 8 ? "none" : "";
  }

  function currentRatio() {
    var total = available();
    if (!total || !st.el.editor) return st.wide ? st.ratio.row : st.ratio.col;
    var size = st.wide ? st.el.editor.offsetWidth : st.el.editor.offsetHeight;
    return size / total;
  }

  function onMove(event) {
    if (!st.dragging) return;
    var total = available();
    if (total <= 0) return;
    var pos = st.wide ? event.clientX : event.clientY;
    var delta = pos - st.startPos;
    var size = st.startSize + delta;
    var maxEditor = Math.max(MIN_EDITOR, total - MIN_PRESETS);
    size = Math.min(Math.max(size, MIN_EDITOR), maxEditor);

    applySizes(size, total);
    if (st.el.resizer) st.el.resizer.classList.add("active");

    if (st.wide) st.ratio.row = size / total;
    else st.ratio.col = size / total;
    if (event.preventDefault) event.preventDefault();
  }

  function stop() {
    if (!st.dragging) return;
    st.dragging = false;
    if (st.el.resizer) st.el.resizer.classList.remove("active");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    save();
  }

  function start(event) {
    if (!st.el.editor) return;
    st.wide = isWide();
    st.dragging = true;
    st.startPos = st.wide ? event.clientX : event.clientY;
    st.startSize = st.wide ? st.el.editor.offsetWidth : st.el.editor.offsetHeight;
    document.body.style.cursor = st.wide ? "ew-resize" : "ns-resize";
    document.body.style.userSelect = "none";
    if (st.el.resizer) st.el.resizer.classList.add("active");
    if (event.preventDefault) event.preventDefault();
  }

  function relayout() {
    st.wide = isWide();
    apply(st.wide ? st.ratio.row : st.ratio.col);
    if (st.el.resizer) {
      st.el.resizer.setAttribute("aria-orientation", st.wide ? "vertical" : "horizontal");
    }
  }

  function init(options) {
    var opts = options || {};
    st.el.split = opts.split || document.getElementById("curveSplit");
    st.el.editor = opts.editor || document.getElementById("curveEditorPane");
    st.el.presets = opts.presets || document.getElementById("curvePresetsPane");
    st.el.resizer = opts.resizer || document.getElementById("curveResizer");
    if (!st.el.split || !st.el.editor || !st.el.presets || !st.el.resizer) return false;

    load();
    st.wide = isWide();
    apply(st.wide ? st.ratio.row : st.ratio.col);

    st.el.resizer.addEventListener("mousedown", start);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", stop);
    window.addEventListener("resize", relayout);

    return true;
  }

  return {
    init: init,
    relayout: relayout,
    isWide: function () {
      return isWide();
    },
    ratio: currentRatio
  };
})();
