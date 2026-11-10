/* Resizable category columns for effects and presets. */
var AEV_SidebarResize = (function () {
  var MIN_WIDTH = { effects: 104, presets: 112 };
  var MAIN_MIN_WIDTH = 120;
  var active = null;

  function byKind(kind) {
    return document.querySelector('[data-sidebar-kind="' + kind + '"]');
  }

  function viewOf(handle) {
    return handle.parentElement;
  }

  function asideOf(view, kind) {
    if (kind === "effects") return view.querySelector(".sidebar");
    return view.querySelector(".preset-sidebar");
  }

  function maxWidth(handle) {
    var view = viewOf(handle);
    var kind = handle.getAttribute("data-sidebar-kind");
    if (!view.clientWidth) return 1000;
    return Math.max(
      MIN_WIDTH[kind],
      view.clientWidth - handle.offsetWidth - MAIN_MIN_WIDTH
    );
  }

  function updateAria(handle, width) {
    var kind = handle.getAttribute("data-sidebar-kind");
    handle.setAttribute("aria-valuemin", String(MIN_WIDTH[kind]));
    handle.setAttribute("aria-valuemax", String(Math.round(maxWidth(handle))));
    handle.setAttribute("aria-valuenow", String(Math.round(width)));
  }

  function applyWidth(handle, width) {
    var kind = handle.getAttribute("data-sidebar-kind");
    var view = viewOf(handle);
    var clamped = Math.max(MIN_WIDTH[kind], Math.min(width, maxWidth(handle)));
    view.style.setProperty("--category-width", Math.round(clamped) + "px");
    updateAria(handle, clamped);
    return clamped;
  }

  function stopDrag() {
    if (!active) return;
    var handle = active.handle;
    var aside = asideOf(viewOf(handle), handle.getAttribute("data-sidebar-kind"));
    AEV_Prefs.setSidebarWidth(
      handle.getAttribute("data-sidebar-kind"),
      aside.getBoundingClientRect().width
    );
    handle.classList.remove("resizing");
    document.body.classList.remove("is-resizing-sidebar");
    active = null;
  }

  function startDrag(event) {
    if (event.button !== 0) return;
    var handle = this;
    var aside = asideOf(viewOf(handle), handle.getAttribute("data-sidebar-kind"));
    active = {
      handle: handle,
      startX: event.clientX,
      startWidth: aside.getBoundingClientRect().width
    };
    handle.classList.add("resizing");
    document.body.classList.add("is-resizing-sidebar");
    event.preventDefault();
  }

  function move(event) {
    if (!active) return;
    applyWidth(active.handle, active.startWidth + event.clientX - active.startX);
    event.preventDefault();
  }

  function init() {
    var handles = document.querySelectorAll("[data-sidebar-resizer]");
    for (var i = 0; i < handles.length; i++) {
      var handle = handles[i];
      var kind = handle.getAttribute("data-sidebar-kind");
      var saved = AEV_Prefs.sidebarWidth(kind);
      if (saved) applyWidth(handle, saved);
      else {
        var aside = asideOf(viewOf(handle), kind);
        updateAria(handle, aside.getBoundingClientRect().width);
      }
      handle.addEventListener("mousedown", startDrag);
    }
    function syncVisibleWidths() {
      for (var j = 0; j < handles.length; j++) {
        var current = asideOf(viewOf(handles[j]), handles[j].getAttribute("data-sidebar-kind"));
        if (current.getBoundingClientRect().width) {
          updateAria(handles[j], current.getBoundingClientRect().width);
        }
      }
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stopDrag);
    window.addEventListener("resize", syncVisibleWidths);
    var tabs = document.querySelectorAll(".view-tab");
    for (var t = 0; t < tabs.length; t++) {
      tabs[t].addEventListener("click", function () {
        window.setTimeout(syncVisibleWidths, 0);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { applyWidth: applyWidth };
})();
