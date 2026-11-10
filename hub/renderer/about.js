/* DreamEngine Hub about dialog. */
(() => {
  const byId = (id) => document.getElementById(id);
  let updateUrl = "";

  function openExternal(url) {
    if (window.hub?.openExternal) {
      window.hub.openExternal(url);
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  function copyText(text) {
    if (window.hub?.copyText) return window.hub.copyText(text);
    return false;
  }

  function showCopyResult(copied) {
    const output = byId("aboutCopyQqLabel");
    if (!output) return;
    output.textContent = copied ? "已复制" : "复制失败";
    window.setTimeout(() => {
      output.textContent = "复制";
    }, 1400);
  }

  function setUpdateStatus(text, state) {
    const row = byId("aboutUpdate");
    const status = byId("aboutUpdateStatus");
    if (status) status.textContent = text;
    if (row) row.classList.toggle("has-update", state === "available");
  }

  function setVersion(value) {
    const version = String(value || "").trim();
    if (!version) return;
    const aboutVersion = byId("aboutVersion");
    if (aboutVersion) aboutVersion.textContent = "v" + version.replace(/^v/i, "");
    setUpdateStatus("当前版本 v" + version.replace(/^v/i, ""), "current");
  }

  async function loadAppVersion() {
    const fallback = byId("extVersion")?.textContent.trim();
    if (fallback) setVersion(fallback);
    if (!window.hub?.appVersion) return;
    try {
      const info = await window.hub.appVersion();
      setVersion(info?.releaseVersion || info?.version || fallback);
    } catch {
      /* 读取版本失败时保留扩展版本或静态文案 */
    }
  }

  async function checkForUpdates() {
    const button = byId("aboutCheckUpdate");
    if (!button) return;
    if (updateUrl) {
      openExternal(updateUrl);
      return;
    }
    if (!window.hub?.checkUpdates) {
      setUpdateStatus("当前环境不支持在线检查", "error");
      return;
    }
    button.disabled = true;
    button.textContent = "检查中…";
    setUpdateStatus("正在连接 GitHub Releases…", "checking");
    try {
      const result = await window.hub.checkUpdates();
      if (!result || !result.ok) {
        setUpdateStatus("检查失败：" + String(result?.reason || "网络不可用"), "error");
        button.textContent = "重试";
        return;
      }
      if (result.updateAvailable) {
        updateUrl = String(result.releaseUrl || "");
        button.textContent = "查看更新";
        setUpdateStatus("发现新版本 " + String(result.latestTag || result.latestVersion || ""), "available");
        return;
      }
      updateUrl = "";
      button.textContent = "重新检查";
      setUpdateStatus("已是最新版本（v" + String(result.currentVersion || "").replace(/^v/i, "") + "）", "current");
    } catch (error) {
      setUpdateStatus("检查失败：" + String(error?.message || error), "error");
      button.textContent = "重试";
    } finally {
      button.disabled = false;
    }
  }

  function setOpen(open) {
    const dialog = byId("aboutDialog");
    const trigger = byId("brandMark");
    if (!dialog || !trigger) return;
    dialog.hidden = !open;
    trigger.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      byId("aboutClose").focus();
    } else {
      trigger.focus();
    }
  }

  function trapFocus(event) {
    const dialog = byId("aboutDialog");
    if (!dialog || dialog.hidden || event.key !== "Tab") return;
    const items = dialog.querySelectorAll("button:not([disabled])");
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function init() {
    const trigger = byId("brandMark");
    const dialog = byId("aboutDialog");
    if (!trigger || !dialog) return;

    trigger.addEventListener("click", () => setOpen(dialog.hidden));
    byId("aboutClose").addEventListener("click", () => setOpen(false));
    dialog.addEventListener("mousedown", (event) => {
      if (event.target === dialog) setOpen(false);
    });

    for (const id of ["aboutDouyin", "aboutGithub"]) {
      byId(id).addEventListener("click", (event) => {
        openExternal(event.currentTarget.dataset.url);
      });
    }

    byId("aboutCopyQq").addEventListener("click", async () => {
      const copied = await copyText(byId("aboutQqNumber").textContent.trim());
      showCopyResult(Boolean(copied));
    });
    byId("aboutCheckUpdate").addEventListener("click", checkForUpdates);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !dialog.hidden) {
        event.stopPropagation();
        setOpen(false);
      } else {
        trapFocus(event);
      }
    });

    loadAppVersion();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.AEV_About = {
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
})();
