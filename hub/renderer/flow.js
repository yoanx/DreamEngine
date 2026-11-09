/* ============================================================
 * flow.js —— 「预览渲染」引导式流程
 *
 * 五步：选择类型 → 选择目标 → 确认配置 → 渲染 → 结果
 * 中间还有两个子步骤：③a 属性获取、③b 人工调参（只在效果类型下出现）。
 *
 * 这一层只做界面与状态机，真正的渲染/获取都交给主进程 spawn 的脚本；
 * 运行计划（plan）只存在内存里，不落盘（唯一例外：渲染进行中重开窗口
 * 时会把界面恢复到第 ④ 步继续轮询）。
 *
 * 依赖 app.js 的全局：state / setView / setStatus / toFileUrl / frameUrl /
 * effectDisplayName / EFFECT_STATUS 等（都是同一全局作用域的函数声明）。
 * ============================================================ */

(function () {
  "use strict";

  const STEPS = ["type", "select", "confirm", "acquire", "tuning", "run", "result"];
  /* 步骤条上显示的 5 个主步骤；acquire / tuning 属于第 3 步的子步骤 */
  const PRIMARY = ["type", "select", "confirm", "run", "result"];
  const SUB_OF_CONFIRM = { acquire: "人工调参 · 获取属性", tuning: "人工调参 · 调整参数" };
  const CONFIG_KEY = "dreamengine.previewFlow.v1";

  const flow = {
    step: "type",
    kinds: ["preset", "effect"],
    kind: null,
    plan: { items: [], config: { ae: "", background: "", limit: 40, rounds: 40, force: false } },
    reached: new Set(["type"]),
    /* 从库进入：记下入口，用于左上角「← 返回」和第 3 步的「来自库选择」提示 */
    entry: null,
    /* 人工调参子流程 */
    tuning: {
      active: false,
      current: "",
      tab: "todo",
      onlyChanged: false,
      collapsed: new Set(),
      paramQuery: "",
      effectQuery: "",
      index: {},
      cache: new Map(),
      raw: new Map(),
      failed: new Map(),
      refetch: new Set(),
      polling: false,
      api: false,
      /* 本次运行计划是否已经走过一轮人工调参（用户点过「完成调参」） */
      done: false,
      doneAt: "",
    },
    selection: {
      query: "",
      filterA: "",
      filterB: "",
      hideRendered: false,
    },
    run: {
      polling: null,
      logTimer: null,
      summary: null,
      startedAt: 0,
    },
  };

  /* ---------------- 小工具 ---------------- */

  function el(id) {
    return document.getElementById(id);
  }
  function setText(id, text) {
    const node = el(id);
    if (node) node.textContent = text == null ? "" : String(text);
  }
  function show(id, visible) {
    const node = el(id);
    if (node) node.hidden = !visible;
  }
  function clear(node) {
    if (node) node.textContent = "";
    return node;
  }
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function fileUrl(path) {
    if (!path) return "";
    try {
      if (typeof toFileUrl === "function") return toFileUrl(path);
    } catch (_error) {
      /* 退回手工拼 */
    }
    return "file:///" + String(path).replace(/\\/g, "/").replace(/^\/+/, "");
  }
  function previewFor(item) {
    if (!item) return "";
    if (item.thumb) return fileUrl(item.thumb);
    if (item.framePattern) return fileUrl(String(item.framePattern).replace("%04d", "0000"));
    if (item.photo) return fileUrl(item.photo);
    return "";
  }
  function nowClock() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      return null;
    }
  }
  function saveConfig() {
    try {
      localStorage.setItem(
        CONFIG_KEY,
        JSON.stringify({
          kind: flow.kind,
          config: flow.plan.config,
        }),
      );
    } catch (_error) {
      /* 忽略存储失败 */
    }
  }
  function busyHint(kind) {
    return kind === "effect" ? "插件效果" : "预设";
  }

  /* AE 崩溃修复看守：全局开关（设置页 / 确认页 / 获取页共用一份偏好） */
  const AE_GUARD_KEY = "dreamengine.aeGuard.v1";
  function aeGuardEnabled() {
    try {
      const raw = localStorage.getItem(AE_GUARD_KEY);
      if (raw === null) return true; // 默认打开
      return raw !== "0";
    } catch (_error) {
      return true;
    }
  }
  function setAeGuardEnabled(value) {
    try {
      localStorage.setItem(AE_GUARD_KEY, value ? "1" : "0");
    } catch (_error) {
      /* 忽略存储失败 */
    }
    const confirmBox = el("flowAeGuard");
    if (confirmBox) confirmBox.checked = !!value;
    const acquireBox = el("flowAcquireGuard");
    if (acquireBox) acquireBox.checked = !!value;
    const settingsBox = el("setAeGuard");
    if (settingsBox) settingsBox.checked = !!value;
  }
  function statusText(item) {
    if (!item) return "";
    if (item.status === "rendered") return "已生成";
    if (item.status === "blacklisted") return "已跳过";
    if (item.status === "excluded") return "不可渲染";
    if (item.status === "no_preview") return "无预览资格";
    if (item.status === "unknown") return "目录中不存在";
    if (item.status === "pending") return "待渲染";
    return item.status || "";
  }

  /* ---------------- 步骤条与轨道 ---------------- */

  function paintSteps() {
    const order = ["type", "select", "confirm", "run", "result"];
    const activePrimary = flow.step === "acquire" || flow.step === "tuning" ? "confirm" : flow.step;
    const activeIndex = order.indexOf(activePrimary);
    const reachedPrimary = flow.reached.has("result")
      ? 5
      : flow.reached.has("run")
        ? 4
        : flow.reached.has("confirm")
          ? 3
          : flow.reached.has("select")
            ? 2
            : 1;
    const nodes = document.querySelectorAll("#flowSteps .flow-step-item");
    nodes.forEach((node) => {
      const step = node.getAttribute("data-flow-step");
      const index = order.indexOf(step);
      const done = index < activeIndex || (index <= reachedPrimary - 1 && index < activeIndex);
      node.classList.toggle("active", index === activeIndex);
      node.classList.toggle("done", index < activeIndex);
      node.classList.toggle("disabled", index > Math.max(reachedPrimary - 1, activeIndex));
      node.setAttribute(
        "aria-current",
        index === activeIndex ? "step" : "false",
      );
      node.setAttribute("data-reached", index <= reachedPrimary - 1 ? "1" : "0");
    });

    /* 子步骤条：③a / ③b */
    const sub = el("flowSubsteps");
    if (sub) {
      const inSub = flow.step === "acquire" || flow.step === "tuning";
      sub.hidden = !inSub;
      if (inSub) setText("flowSubstepLabel", SUB_OF_CONFIRM[flow.step] || "");
    }

    const back = el("flowLibBack");
    if (back) back.hidden = !flow.entry;

    /* 顶栏页签的小圆点：渲染进行中 */
    show("tabRenderDot", !!(flow.run.polling || isAnyRunning()));
  }

  function trackIndex(step) {
    return STEPS.indexOf(step);
  }

  function go(step, options) {
    const opts = options || {};
    if (!STEPS.includes(step)) return;
    if (!opts.force) {
      /* 有向回退：只能去已经到达过的步骤 */
      if (!flow.reached.has(step) && trackIndex(step) > maxReachedTrackIndex()) return;
    }
    flow.step = step;
    flow.reached.add(step);
    const track = el("flowTrack");
    if (track) track.style.transform = "translateX(" + -trackIndex(step) * 100 + "%)";
    paintSteps();
    /* 各步骤进入钩子 */
    if (step === "type") paintKinds();
    if (step === "select") paintSelection();
    if (step === "confirm") paintConfirm();
    if (step === "acquire") paintAcquire();
    if (step === "tuning") paintTuning();
    if (step === "run") paintRun();
    if (step === "result") paintResult();
    const view = el("viewRender");
    if (view) view.scrollTop = 0;
  }

  function maxReachedTrackIndex() {
    let best = 0;
    for (const step of flow.reached) best = Math.max(best, trackIndex(step));
    return best;
  }

  function requestStep(step) {
    if (flow.step === "run" && flow.run.polling) return;
    go(step, { force: flow.reached.has(step) });
  }

  /* ---------------- ① 选择类型 ---------------- */

  function presetItems() {
    return Array.isArray(state && state.presets) ? state.presets : [];
  }
  function effectItems() {
    const data = state && state.effectData;
    return data && Array.isArray(data.items) ? data.items : [];
  }

  function paintKinds() {
    const presets = presetItems();
    const effects = effectItems();
    setText(
      "flowKindPresetMeta",
      presets.length ? "库内 " + presets.length + " 个预设" : "预设库还是空的",
    );
    setText(
      "flowKindEffectMeta",
      effects.length
        ? "库内 " + effects.length + " 个效果（含插件）"
        : "效果库还是空的，先在效果库同步插件目录",
    );
  }

  function resetTuningDone() {
    flow.tuning.done = false;
    flow.tuning.doneAt = "";
  }

  function chooseKind(kind) {
    if (kind !== "preset" && kind !== "effect") return;
    const conflict = flow.plan.items.length > 0 && flow.kind && flow.kind !== kind;
    if (conflict && !window.confirm("切换渲染目标类型会清空当前运行计划，确定继续吗？")) return;
    if (conflict) flow.plan.items = [];
    flow.kind = kind;
    flow.plan.config.limit = kind === "effect" ? 8 : 40;
    flow.plan.config.rounds = kind === "effect" ? 200 : 40;
    resetTuningDone();
    saveConfig();
    /* 进入第 2 步属于前进，必须放行（有向回退只拦跳过步骤） */
    go("select", { force: true });
  }

  /* ---------------- ② 选择渲染目标 ---------------- */

  function itemKey(kind, item) {
    return kind === "preset" ? String(item.path || "") : String(item.matchName || "");
  }
  function itemName(kind, item) {
    if (kind === "preset") return String(item.name || item.path || "");
    try {
      if (typeof effectDisplayName === "function") return effectDisplayName(item);
    } catch (_error) {
      /* 忽略 */
    }
    return String(item.displayName || item.name || item.matchName || "");
  }
  function planKeys() {
    return new Set(flow.plan.items.map((item) => item.key));
  }
  function isSelected(kind, item) {
    return planKeys().has(itemKey(kind, item));
  }
  function toggleItem(kind, item) {
    const key = itemKey(kind, item);
    if (!key) return;
    const keys = planKeys();
    if (keys.has(key)) {
      flow.plan.items = flow.plan.items.filter((entry) => entry.key !== key);
    } else {
      flow.plan.items.push({
        key,
        kind,
        name: itemName(kind, item),
        meta: itemMetaText(kind, item),
        status: kind === "effect" ? String(item.status || "pending") : item.rendered ? "rendered" : "pending",
        reason: String(item.reason || ""),
        manualTuning: false,
        presetPath: kind === "preset" ? String(item.path || "") : "",
        matchName: kind === "effect" ? String(item.matchName || "") : "",
        plugin: kind === "effect" ? String(item.plugin || "") : "",
        category: kind === "effect" ? String(item.category || "") : "",
      });
    }
    resetTuningDone();
    paintSelection();
  }

  function itemMetaText(kind, item) {
    if (kind === "preset") {
      const bits = [];
      if (item.external) bits.push("外部");
      else bits.push("我的");
      return bits.join(" · ");
    }
    const bits = [];
    if (item.plugin) bits.push(String(item.plugin));
    if (item.category) bits.push(String(item.category));
    return bits.join(" · ");
  }

  function visibleSelectionItems() {
    const kind = flow.kind;
    const query = flow.selection.query.trim().toLowerCase();
    const list = kind === "preset" ? presetItems() : effectItems();
    return list.filter((item) => {
      const name = itemName(kind, item);
      if (query && name.toLowerCase().indexOf(query) < 0) return false;
      if (kind === "preset") {
        if (flow.selection.filterA) {
          const categoryName =
            typeof categoryFor === "function" ? categoryNameFor(item) : "";
          if (categoryName !== flow.selection.filterA) return false;
        }
        if (flow.selection.filterB === "mine" && item.external) return false;
        if (flow.selection.filterB === "external" && !item.external) return false;
        if (flow.selection.hideRendered && item.rendered) return false;
      } else {
        if (flow.selection.filterA && String(item.plugin || "") !== flow.selection.filterA) return false;
        if (flow.selection.filterB && String(item.status || "") !== flow.selection.filterB) return false;
        if (flow.selection.hideRendered && item.status === "rendered") return false;
      }
      return true;
    });
  }

  function categoryNameFor(item) {
    try {
      if (typeof categoryFor === "function") {
        const id = categoryFor(item.path);
        if (!id) return "未分类";
        const list = typeof categories === "function" ? categories() : [];
        const hit = list.find((entry) => entry.id === id);
        return hit ? String(hit.name) : "未分类";
      }
    } catch (_error) {
      /* 忽略 */
    }
    return "未分类";
  }

  function badgeFor(kind, item) {
    if (kind === "preset") {
      return item.rendered ? { cls: "ok", text: "已生成" } : { cls: "warn", text: "未生成" };
    }
    const status = String(item.status || "pending");
    if (status === "rendered") return { cls: "ok", text: "已生成" };
    if (status === "blacklisted") return { cls: "bad", text: "已跳过" };
    if (status === "excluded" || status === "no_preview") return { cls: "bad", text: statusText(item) };
    return { cls: "warn", text: "待渲染" };
  }

  function fillSelect(node, entries, value) {
    if (!node) return;
    const current = value == null ? node.value : value;
    node.textContent = "";
    for (const entry of entries) {
      const option = document.createElement("option");
      option.value = entry.value;
      option.textContent = entry.label;
      node.appendChild(option);
    }
    if (current && entries.some((entry) => entry.value === current)) node.value = current;
    else if (entries.length) node.value = entries[0].value;
  }

  function paintSelectionFilters() {
    const kind = flow.kind;
    const nodeA = el("flowSelectFilterA");
    const nodeB = el("flowSelectFilterB");
    if (kind === "preset") {
      const names = new Set();
      for (const item of presetItems()) names.add(categoryNameFor(item));
      fillSelect(
        nodeA,
        [{ value: "", label: "全部分类" }].concat(
          Array.from(names)
            .sort((a, b) => a.localeCompare(b, "zh-CN"))
            .map((name) => ({ value: name, label: name })),
        ),
        flow.selection.filterA,
      );
      fillSelect(
        nodeB,
        [
          { value: "", label: "全部来源" },
          { value: "mine", label: "我的" },
          { value: "external", label: "外部" },
        ],
        flow.selection.filterB,
      );
      const hide = el("flowSelectHide");
      if (hide) hide.checked = flow.selection.hideRendered;
      setText("flowSelectTitle", "选择预设");
      setText("flowSelectSub", "可多选，选中的条目会拷贝进运行计划");
    } else {
      const plugins = new Set();
      for (const item of effectItems()) plugins.add(String(item.plugin || ""));
      fillSelect(
        nodeA,
        [{ value: "", label: "全部插件" }].concat(
          Array.from(plugins)
            .sort((a, b) => a.localeCompare(b, "zh-CN"))
            .map((name) => ({ value: name, label: name || "未知" })),
        ),
        flow.selection.filterA,
      );
      fillSelect(
        nodeB,
        [
          { value: "", label: "全部状态" },
          { value: "pending", label: "待渲染" },
          { value: "rendered", label: "已生成" },
          { value: "blacklisted", label: "已跳过" },
          { value: "excluded", label: "不可渲染" },
        ],
        flow.selection.filterB,
      );
      const hide = el("flowSelectHide");
      if (hide) hide.checked = flow.selection.hideRendered;
      setText("flowSelectTitle", "选择效果");
      setText("flowSelectSub", "可多选，不可渲染的条目也会保留并标注原因");
    }
    show("flowSelectHideWrap", true);
  }

  function paintSelection() {
    paintSelectionFilters();
    const kind = flow.kind;
    const list = clear(el("flowSelectList"));
    if (!list) return;
    const visible = visibleSelectionItems();
    const keys = planKeys();
    for (const item of visible) {
      const key = itemKey(kind, item);
      const row = make("div", "flow-select-row");
      row.setAttribute("data-key", key);
      if (keys.has(key)) row.classList.add("selected");
      const badge = badgeFor(kind, item);
      if (kind === "effect" && (badge.cls === "bad" || item.status === "blacklisted")) {
        row.classList.add("disabled");
        row.title = statusText(item) + (item.reason ? " · " + item.reason : "");
      }

      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "check";
      check.checked = keys.has(key);
      check.setAttribute("aria-label", "选择 " + itemName(kind, item));
      row.appendChild(check);

      const thumb = previewFor(item);
      if (thumb) {
        const img = document.createElement("img");
        img.className = "flow-select-thumb";
        img.src = thumb;
        img.alt = "";
        img.loading = "lazy";
        row.appendChild(img);
      } else {
        row.appendChild(make("div", "flow-select-thumb flow-select-thumb-empty"));
      }

      const info = make("div", "flow-select-info");
      info.appendChild(make("div", "flow-select-name", itemName(kind, item)));
      info.appendChild(make("div", "flow-select-meta", itemMetaText(kind, item)));
      row.appendChild(info);

      row.appendChild(make("span", "flow-select-badge " + badge.cls, badge.text));
      row.addEventListener("click", (event) => {
        if (event.target === check) return;
        toggleItem(kind, item);
      });
      check.addEventListener("change", () => toggleItem(kind, item));
      list.appendChild(row);
    }
    if (!visible.length) {
      list.appendChild(make("div", "empty", "没有匹配的条目。"));
    }
    const total = flow.plan.items.length;
    const unrenderable = flow.plan.items.filter(
      (item) => item.status && item.status !== "rendered" && item.status !== "pending",
    ).length;
    setText(
      "flowSelectCount",
      "已选 " + total + " 项" + (unrenderable ? "，其中 " + unrenderable + " 项不可渲染" : ""),
    );
    const next = el("flowSelectNext");
    if (next) next.disabled = total === 0;
    paintSteps();
  }

  function selectAllFiltered() {
    const kind = flow.kind;
    const keys = planKeys();
    for (const item of visibleSelectionItems()) {
      const key = itemKey(kind, item);
      if (!key || keys.has(key)) continue;
      flow.plan.items.push({
        key,
        kind,
        name: itemName(kind, item),
        meta: itemMetaText(kind, item),
        status: kind === "effect" ? String(item.status || "pending") : item.rendered ? "rendered" : "pending",
        reason: String(item.reason || ""),
        manualTuning: false,
        presetPath: kind === "preset" ? String(item.path || "") : "",
        matchName: kind === "effect" ? String(item.matchName || "") : "",
        plugin: kind === "effect" ? String(item.plugin || "") : "",
        category: kind === "effect" ? String(item.category || "") : "",
      });
    }
    resetTuningDone();
    paintSelection();
  }

  /* ---------------- ③ 确认渲染配置 ---------------- */

  function aeOptions() {
    const installed =
      state && state.snapshot && state.snapshot.ae && Array.isArray(state.snapshot.ae.installed)
        ? state.snapshot.ae.installed
        : [];
    return installed.map((entry) => ({
      value: String(entry.exe || ""),
      label: `${String(entry.name || entry.version || "After Effects")} (${String(entry.version || "")})`,
    }));
  }

  /** 没存过选择时，默认用插件目录扫描的那一版 AE，避免目录/缓存与实际 AE 对不上。 */
  function defaultAeExe() {
    const meta = state && state.snapshot && state.snapshot.catalogMeta;
    const exe = meta ? String(meta.aeExe || "") : "";
    if (!exe) return "";
    return aeOptions().some((entry) => entry.value === exe) ? exe : "";
  }

  async function fillBackgroundSelect() {
    const node = el("flowBackground");
    if (!node) return;
    let list = [];
    try {
      /* 主进程 backgrounds:list 直接返回数组；这里兼容 {items:[...]} 两种形状 */
      const data = await window.hub.listBackgrounds();
      list = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : [];
    } catch (_error) {
      list = [];
    }
    const entries = list
      .map((item) => ({
        value: String(item.id != null ? item.id : item.value || ""),
        label: String(item.label || item.name || item.id || ""),
      }))
      .filter((entry) => entry.value && entry.value !== "__custom__");
    if (!entries.length) entries.push({ value: "photo", label: "标准素材" });
    entries.push({ value: "__custom__", label: "自己添加…" });
    fillSelect(node, entries, flow.plan.config.background);
    flow.plan.config.background = node.value === "__custom__" ? "" : node.value;
  }

  function paintConfirm() {
    const kind = flow.kind;
    if (!kind) {
      go("type", { force: true });
      return;
    }
    const list = clear(el("flowPlanList"));
    const items = flow.plan.items;
    setText("flowPlanCount", items.length + " 项");
    setText("flowPlanSub", items.length ? "" : "运行计划是空的");
    if (list) {
      for (const item of items) {
        const row = make("div", "flow-plan-row");
        const thumb = previewFor(findSourceItem(kind, item));
        if (thumb) {
          const img = document.createElement("img");
          img.className = "flow-select-thumb";
          img.src = thumb;
          img.alt = "";
          img.loading = "lazy";
          row.appendChild(img);
        } else {
          row.appendChild(make("div", "flow-select-thumb flow-select-thumb-empty"));
        }
        const info = make("div", "flow-plan-info");
        info.appendChild(make("div", "flow-select-name", item.name));
        const meta = make("div", "flow-select-meta", item.meta || "");
        const badge = make("span", "flow-select-badge " + (item.status === "rendered" ? "ok" : item.status && item.status !== "pending" ? "bad" : "warn"));
        badge.textContent = statusText({ status: item.status }) || "待渲染";
        meta.appendChild(badge);
        info.appendChild(meta);
        row.appendChild(info);

        if (kind === "effect") {
          const toggle = make("label", "flow-plan-toggle");
          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = !!item.manualTuning;
          box.addEventListener("change", () => {
            item.manualTuning = box.checked;
            /* 计划里的人参条目变了，之前那轮「完成调参」就不再作数 */
            resetTuningDone();
            paintConfirm();
          });
          toggle.appendChild(box);
          toggle.appendChild(make("span", null, "人工调参"));
          row.appendChild(toggle);
        }
        list.appendChild(row);
      }
      if (!items.length) list.appendChild(make("div", "empty", "还没有选择任何目标。"));
    }

    /* 配置表单回显 */
    const config = flow.plan.config;
    if (!config.ae) config.ae = defaultAeExe();
    const aeNode = el("flowAeVersion");
    if (aeNode) fillSelect(aeNode, aeOptions().concat([{ value: "", label: "默认（跟随插件目录版本）" }]), config.ae);
    fillBackgroundSelect();
    const bg = el("flowBackground");
    if (bg && config.background) bg.value = config.background;
    if (!config.background) config.background = "photo";
    const limit = el("flowLimit");
    if (limit) limit.value = config.limit;
    const rounds = el("flowRounds");
    if (rounds) rounds.value = config.rounds;
    const force = el("flowForce");
    if (force) force.checked = !!config.force;
    const guardBox = el("flowAeGuard");
    if (guardBox) guardBox.checked = aeGuardEnabled();
    setText("flowLimitLabel", kind === "effect" ? "每批条数" : "每实例最多");

    const tuningItems = items.filter((item) => item.manualTuning);
    const blacklisted = items.filter((item) => item.status === "blacklisted");
    const tuningDone = flow.tuning.done && tuningItems.length > 0;
    const noteLines = [];
    if (tuningItems.length && !tuningDone) {
      noteLines.push(
        "已为 " +
          tuningItems.length +
          " 个效果开启人工调参：下一步会先获取缺少的属性，再进入调参界面。",
      );
    }
    if (tuningDone) {
      noteLines.push(
        "已完成人工调参：已改动 " +
          changedTuningCount() +
          " 条，改动已保存。" +
          (flow.tuning.doneAt ? "（最后 " + flow.tuning.doneAt + "）" : "") +
          "可以直接开始渲染；要再修改点下方的「继续调参」。",
      );
    }
    if (blacklisted.length) {
      noteLines.push(
        "计划里有 " +
          blacklisted.length +
          " 个已跳过的效果；本次会强制重渲它们（失败后会被重新记回黑名单）。",
      );
    }
    if (!tuningItems.length && !blacklisted.length) {
      noteLines.push(
        items.length
          ? "确认配置后开始渲染；已经生成过或不可渲染的条目会被跳过，并记进第 5 步结果。"
          : "返回第 2 步挑选要渲染的条目。",
      );
    }
    const note = el("flowTuneNote");
    if (note) {
      note.hidden = noteLines.length === 0;
      note.textContent = noteLines.join(" ");
    }
    const retune = el("flowConfirmRetune");
    if (retune) retune.hidden = !tuningDone;
    const next = el("flowConfirmNext");
    if (next) {
      next.textContent = tuningItems.length && !tuningDone ? "下一步：人工调参" : "开始渲染";
      next.disabled = items.length === 0;
    }
  }

  /* 已改动参数条数：用于确认页「已调参 N 条」提示 */
  function changedTuningCount() {
    return tuningTargets().reduce((sum, item) => sum + overrideCount(item.key), 0);
  }

  function findSourceItem(kind, planItem) {
    const list = kind === "preset" ? presetItems() : effectItems();
    const key = planItem.key;
    return list.find((item) => itemKey(kind, item) === key) || null;
  }

  /* ---------------- 运行计划 → 渲染参数 ---------------- */

  function readConfirmConfig() {
    const config = flow.plan.config;
    const ae = el("flowAeVersion");
    const background = el("flowBackground");
    const limit = el("flowLimit");
    const rounds = el("flowRounds");
    const force = el("flowForce");
    if (ae) config.ae = ae.value;
    if (background && background.value && background.value !== "__custom__") {
      config.background = background.value;
    }
    if (limit) config.limit = Math.max(1, Math.min(64, Number(limit.value) || config.limit || 8));
    if (rounds) config.rounds = Math.max(1, Math.min(200, Number(rounds.value) || config.rounds || 40));
    if (force) config.force = !!force.checked;
    saveConfig();
    return config;
  }

  async function startFromConfirm() {
    const config = readConfirmConfig();
    const tuning = flow.plan.items.filter((item) => item.manualTuning);
    /* 还没走过调参：先进入调参子流程；走过之后直接渲染，想改再点「继续调参」 */
    if (tuning.length && !flow.tuning.done) {
      flow.tuning.active = true;
      go("acquire", { force: true });
      return;
    }
    await startRun();
  }

  /* 重新进入调参：全部有缓存就直接到调参页，否则先走获取页 */
  function reopenTuning() {
    const targets = flow.plan.items.filter((item) => item.manualTuning);
    flow.tuning.active = true;
    flow.tuning.done = false;
    flow.tuning.doneAt = "";
    const allCached = targets.every((item) => !!(flow.tuning.index && flow.tuning.index[item.key]));
    go(allCached ? "tuning" : "acquire", { force: true });
  }

  /* ---------------- ④ 渲染 ---------------- */

  function isAnyRunning() {
    return !!(flow.run.polling || (flow.tuning && flow.tuning.polling));
  }

  function runSummaryText() {
    const config = flow.plan.config;
    const ae = aeLabel(config.ae);
    const bits = [
      flow.kind === "effect" ? "效果" : "预设",
      flow.plan.items.length + " 项",
      "AE：" + (ae || "默认"),
      "背景：" + backgroundLabel(config.background),
      (flow.kind === "effect" ? "每批 " : "每实例 ") + config.limit,
      "重启上限 " + config.rounds,
    ];
    if (config.force) bits.push("强制重渲");
    if (flow.plan.items.some((item) => item.manualTuning)) bits.push("含人工调参");
    return bits;
  }

  function aeLabel(value) {
    if (!value) return "";
    const hit = aeOptions().find((entry) => entry.value === value);
    return hit ? hit.label : String(value).split(/[\\/]/).pop();
  }
  function backgroundLabel(value) {
    if (!value) return "默认";
    const node = el("flowBackground");
    if (node) {
      const option = Array.from(node.options).find((entry) => entry.value === value);
      if (option) return option.textContent;
    }
    return value;
  }

  function paintRun() {
    const bar = el("flowRunSummary");
    if (bar) {
      bar.textContent = "";
      for (const text of runSummaryText()) {
        const span = make("span", "flow-sum-item");
        const label = make("span", null, String(text).split("：")[0]);
        label.style.color = "var(--muted)";
        span.appendChild(label);
        if (String(text).indexOf("：") >= 0) span.appendChild(make("span", null, String(text).split("：")[1]));
        bar.appendChild(span);
      }
    }
    const stop = el("flowRunStop");
    if (stop) stop.disabled = !flow.run.polling;
    const hint = el("flowRunHint");
    if (hint) {
      hint.textContent = flow.run.polling
        ? "渲染进行中：完成后会自动进入结果页，期间不要手动操作 AE 窗口。"
        : "刚才的运行已结束，可以在第 5 步查看结果。";
    }
  }

  /* 运行计划拆成「真的要渲的」和「本次跳过的」；跳过项由 Hub 写进结果表 */
  function runPlanSplit(candidates) {
    const items = Array.isArray(candidates) ? candidates : flow.plan.items;
    const force = !!flow.plan.config.force;
    const targets = [];
    const skips = [];
    for (const item of items) {
      const status = String(item.status || "pending");
      if (status === "excluded") {
        skips.push({ key: item.key, name: item.name, reason: item.reason || "excluded" });
        continue;
      }
      if (status === "rendered" && !force) {
        skips.push({ key: item.key, name: item.name, reason: "already_rendered" });
        continue;
      }
      targets.push(item);
    }
    return { targets, skips, force };
  }

  function optionsForStart(itemsOverride) {
    const config = readConfirmConfig();
    const split = runPlanSplit(itemsOverride);
    const force = split.force || split.targets.some((item) => item.status === "blacklisted");
    const aeGuard = aeGuardEnabled();
    if (flow.kind === "preset") {
      return {
        ae: config.ae,
        background: config.background,
        limit: Math.max(1, Math.min(64, Number(config.limit) || 40)),
        rounds: Math.max(1, Math.min(200, Number(config.rounds) || 40)),
        retryFailed: !force,
        force: force,
        aeGuard: aeGuard,
        presetPaths: split.targets.map((item) => item.presetPath || item.key).filter(Boolean),
        skips: split.skips,
      };
    }
    return {
      ae: config.ae,
      background: config.background,
      limit: Math.max(1, Math.min(64, Number(config.limit) || 8)),
      rounds: Math.max(1, Math.min(200, Number(config.rounds) || 200)),
      force: force,
      aeGuard: aeGuard,
      matchNames: split.targets.map((item) => item.matchName || item.key).filter(Boolean),
      skips: split.skips,
    };
  }

  async function startRun(itemsOverride) {
    readConfirmConfig();
    flow.reached.add("run");
    go("run");
    setText("flowRunPhase", "正在启动…");
    setText("flowRunCurrent", "");
    setText("flowRunCount", "");
    setText("flowRunOk", "");
    setText("flowRunFail", "");
    setText("flowRunRemain", "");
    const bar = el("flowRunBar");
    if (bar) bar.style.width = "0%";
    setText("flowRunHint", "渲染进行中，切到别的页签也会继续。");
    flow.run.startedAt = Date.now();

    const options = optionsForStart(itemsOverride);
    let result = null;
    try {
      result =
        flow.kind === "preset"
          ? await window.hub.startRender(options)
          : await window.hub.startPluginEffects(options);
    } catch (error) {
      setText("flowRunHint", "启动失败：" + String((error && error.message) || error));
      return;
    }
    if (!result || result.ok === false) {
      setText("flowRunHint", "启动失败：" + explainStartError(result));
      return;
    }
    startRunPolling();
  }

  function explainStartError(result) {
    const reason = result && result.reason;
    const map = {
      already_running: "已经有一个任务在运行了",
      preset_render_running: "预设渲染正在进行",
      effect_render_running: "效果渲染正在进行",
      param_dump_running: "属性获取正在进行",
      manual_running: "人工调参正在进行",
      nothing_to_render: "没有需要渲染的条目",
      no_catalog: "插件目录还没扫描",
      write_failed: "写入批次文件失败",
      no_ae: "没有找到 After Effects",
    };
    return map[reason] || String(reason || "未知错误") + (result && result.detail ? "：" + result.detail : "");
  }

  function stopRun() {
    try {
      if (flow.kind === "preset") window.hub.stopRender();
      else window.hub.stopPluginEffects();
    } catch (_error) {
      /* 忽略 */
    }
  }

  function startRunPolling() {
    stopRunPolling();
    pullRunState();
    pullRunLog();
    flow.run.polling = setInterval(pullRunState, 700);
    flow.run.logTimer = setInterval(pullRunLog, 1400);
    paintSteps();
    paintRun();
  }

  function stopRunPolling() {
    if (flow.run.polling) clearInterval(flow.run.polling);
    if (flow.run.logTimer) clearInterval(flow.run.logTimer);
    flow.run.polling = null;
    flow.run.logTimer = null;
    paintSteps();
  }

  async function pullRunState() {
    let snap = null;
    try {
      snap =
        flow.kind === "preset"
          ? await window.hub.renderSnapshot()
          : await window.hub.pluginEffectsSnapshot();
    } catch (_error) {
      return;
    }
    const data = snap && snap.state ? snap.state : snap;
    if (!data) return;
    applyRunState(data);
  }

  function applyRunState(stateData) {
    if (!stateData) return;
    const phase = String(stateData.phase || "");
    const total = Number(stateData.total) || 0;
    const current = Number(stateData.current) || 0;
    const ok = Number(stateData.ok) || 0;
    const fail = Number(stateData.fail) || 0;
    const remain = Number(stateData.remaining);
    setText("flowRunPhase", phaseLabel(phase));
    setText("flowRunCurrent", stateData.currentName ? "当前：" + stateData.currentName : "");
    setText("flowRunCount", total ? current + " / " + total : "");
    setText("flowRunOk", "成功 " + ok);
    setText("flowRunFail", "失败 " + fail);
    setText("flowRunRemain", Number.isFinite(remain) ? "剩余 " + remain : "");
    const bar = el("flowRunBar");
    if (bar) {
      const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
      bar.style.width = percent + "%";
    }
    if (stateData.message && !stateData.currentName) setText("flowRunCurrent", String(stateData.message));
    if (phase === "done" || phase === "failed" || phase === "cancelled") {
      finishRun(phase);
    }
  }

  function phaseLabel(phase) {
    const map = {
      starting: "准备中…",
      "waiting-close": "等待 After Effects 关闭…",
      rendering: "渲染中",
      done: "已完成",
      failed: "已失败",
      cancelled: "已停止",
    };
    return map[phase] || phase || "空闲";
  }

  async function pullRunLog() {
    if (flow.step !== "run" && !flow.run.polling) return;
    try {
      const text =
        flow.kind === "preset"
          ? await window.hub.logTail(5)
          : await window.hub.logPluginEffectsTail(5);
      const body = el("flowRunLogBody");
      if (body) body.textContent = text || "（暂无日志输出）";
    } catch (_error) {
      /* 忽略 */
    }
  }

  let finishing = false;

  /* 渲染结束后刷新预设库/效果库与 AE 状态（旧推送订阅已删除，改由流程主动刷新） */
  async function refreshLibrary() {
    try {
      if (typeof loadPresets === "function") await loadPresets();
      if (typeof loadEffects === "function") await loadEffects();
      if (typeof refreshAeState === "function") await refreshAeState();
    } catch (_error) {
      /* 忽略 */
    }
  }

  async function finishRun(phase) {
    if (finishing) return;
    finishing = true;
    stopRunPolling();
    try {
      await pullRunLog();
    } catch (_error) {
      /* 忽略 */
    }
    await refreshLibrary();
    if (phase === "cancelled") {
      setText("flowRunPhase", "已停止");
      setText("flowRunHint", "已手动停止，下次开始会从断点继续。");
      flow.reached.add("result");
      await paintResult();
      go("result", { force: true });
      finishing = false;
      return;
    }
    flow.reached.add("result");
    await paintResult();
    go("result", { force: true });
    finishing = false;
  }

  /* ---------------- ⑤ 结果 ---------------- */

  function renderRows() {
    return flow.resultRows || [];
  }

  async function paintResult() {
    let csv = [];
    try {
      const data = await window.hub.getPreviewResults();
      if (data && Array.isArray(data.rows)) csv = data.rows;
      else if (Array.isArray(data)) csv = data;
    } catch (_error) {
      csv = [];
    }
    const rows = csv;
    flow.resultRows = rows;
    const ok = rows.filter((row) => row.status === "ok").length;
    const fail = rows.filter((row) => row.status === "fail").length;
    const skip = rows.filter((row) => row.status === "skip").length;

    const counts = clear(el("flowResultCounts"));
    if (counts) {
      const defs = [
        { cls: "ok", value: ok, label: "成功" },
        { cls: "fail", value: fail, label: "失败" },
        { cls: "skip", value: skip, label: "跳过" },
      ];
      for (const def of defs) {
        const card = make("div", "flow-result-count " + def.cls);
        card.appendChild(make("div", "flow-result-count-value", String(def.value)));
        card.appendChild(make("div", "flow-result-count-label", def.label));
        counts.appendChild(card);
      }
    }

    const table = clear(el("flowResultTable"));
    if (table) {
      const head = make("div", "flow-result-row flow-result-head");
      ["名称", "状态", "原因", "说明", "操作"].forEach((text) =>
        head.appendChild(make("span", null, text)),
      );
      table.appendChild(head);
      const order = { fail: 0, skip: 1, ok: 2 };
      const sorted = rows.slice().sort((a, b) => (order[a.status] || 9) - (order[b.status] || 9));
      for (const row of sorted) {
        const line = make("div", "flow-result-row");
        line.appendChild(make("span", "flow-result-name", row.name || row.key || ""));
        const badge = make(
          "span",
          "flow-result-badge " + (row.status === "ok" ? "ok" : row.status === "skip" ? "warn" : "bad"),
          row.status === "ok" ? "成功" : row.status === "skip" ? "跳过" : "失败",
        );
        line.appendChild(badge);
        line.appendChild(make("span", "flow-result-reason", reasonLabel(row.reason)));
        line.appendChild(make("span", "flow-result-note", row.time || ""));
        const action = make("span", "flow-result-action");
        if (row.status === "fail") {
          const logButton = document.createElement("button");
          logButton.type = "button";
          logButton.className = "flow-link-button";
          logButton.textContent = "日志";
          logButton.addEventListener("click", () => openRunLog());
          action.appendChild(logButton);
        }
        line.appendChild(action);
        table.appendChild(line);
      }
      if (!rows.length) table.appendChild(make("div", "empty", "还没有结果记录。"));
    }

    const retry = el("flowResultRetry");
    if (retry) {
      const failures = rows.filter((row) => row.status === "fail");
      retry.hidden = failures.length === 0;
      retry.textContent = failures.length ? "重试失败项 (" + failures.length + ")" : "重试失败项";
    }
    const back = el("flowResultBack");
    if (back) back.disabled = flow.plan.items.length === 0;
    paintSteps();
  }

  function reasonLabel(reason) {
    const map = {
      "": "",
      already_rendered: "已生成",
      blacklisted: "黑名单",
      excluded: "不可渲染",
      no_preview: "无预览资格",
      unknown: "目录中不存在",
      render_error: "渲染报错",
      render_timeout: "超时",
      ae_dialog: "AE 弹窗阻塞",
      crash: "AE 崩溃",
    };
    return map[reason] || String(reason || "");
  }

  async function retryFailed() {
    const failures = renderRows().filter((row) => row.status === "fail");
    if (!failures.length) return;
    const keys = new Set(failures.map((row) => String(row.key || "")));
    const items = flow.plan.items.filter((item) => keys.has(item.key));
    if (!items.length) return;
    // 失败项通常已经进了黑名单或被标记过，重试一律按「强制重渲」处理
    flow.plan.items = items.map((item) => Object.assign({}, item, { status: "pending" }));
    flow.plan.config.force = true;
    await startRun();
  }

  /* ---------------- ③a 获取属性 / ③b 人工调参 ---------------- */

  function tuningTargets() {
    if (flow.tuning.active) {
      const manual = flow.plan.items.filter((item) => item.manualTuning);
      if (manual.length) return manual;
    }
    return flow.plan.items.filter((item) => item.manualTuning);
  }

  function paramApiReady() {
    return !!(window.hub && typeof window.hub.getParamIndex === "function");
  }

  async function refreshParamIndex() {
    if (!paramApiReady()) {
      flow.tuning.api = false;
      return;
    }
    try {
      const data = await window.hub.getParamIndex();
      const items = data && Array.isArray(data.items) ? data.items : [];
      flow.tuning.index = {};
      for (const item of items) flow.tuning.index[item.matchName] = item;
      flow.tuning.api = true;
    } catch (_error) {
      flow.tuning.api = false;
    }
  }

  async function paintAcquire() {
    const targets = tuningTargets();
    setText("flowAcquireAe", "AE 版本：" + (aeLabel(flow.plan.config.ae) || "默认（跟随插件目录版本）"));
    await refreshParamIndex();
    const todo = [];
    const cached = [];
    const failed = [];
    for (const item of targets) {
      const hit = flow.tuning.index[item.key];
      if (flow.tuning.refetch.has(item.key)) todo.push(item);
      else if (hit) cached.push(item);
      else if (flow.tuning.failed.has(item.key)) failed.push(item);
      else todo.push(item);
    }
    setText("flowAcquireTodoCount", String(todo.length + failed.length));
    setText("flowAcquireCachedCount", String(cached.length));
    setText("flowAcquireFailedCount", String(failed.length));
    const limit = el("flowAcquireLimit");
    const rounds = el("flowAcquireRounds");
    const batchLimit = limit ? Math.max(1, Number(limit.value) || 20) : 20;
    const batches = Math.max(1, Math.ceil((todo.length + failed.length) / batchLimit));
    setText(
      "flowAcquirePlan",
      flow.tuning.api
        ? "将分 " + batches + " 批获取 " + (todo.length + failed.length) + " 条"
        : "（当前版本还没有接线属性获取服务）",
    );
    if (rounds) rounds.disabled = !flow.tuning.api;
    const guardBox = el("flowAcquireGuard");
    if (guardBox) guardBox.checked = aeGuardEnabled();
    paintAcquireList(todo, cached, failed);
    const start = el("flowAcquireStart");
    if (start) {
      start.hidden = !flow.tuning.api || todo.length + failed.length === 0;
      start.disabled = !flow.tuning.api || flow.tuning.polling;
    }
    const skip = el("flowAcquireSkip");
    if (skip) skip.hidden = !flow.tuning.api || todo.length === 0;
    show("flowAcquireStop", !!flow.tuning.polling);
    const cont = el("flowAcquireContinue");
    if (cont) cont.hidden = !!flow.tuning.polling || (todo.length === 0 && cached.length === 0);
  }

  function paintAcquireList(todo, cached, failed) {
    const node = clear(el("flowAcquireList"));
    if (!node) return;
    const tab = flow.tuning.tab;
    const rows = tab === "cached" ? cached : tab === "failed" ? failed : todo.concat(failed);
    for (const item of rows) {
      const row = make("div", "flow-acquire-row");
      row.appendChild(make("span", "flow-select-name", item.name));
      row.appendChild(make("span", "flow-select-meta", item.meta || ""));
      const hit = flow.tuning.index[item.key];
      if (hit && hit.fetchedAt) {
        row.appendChild(make("span", "flow-select-badge ok", "获取于 " + String(hit.fetchedAt).slice(0, 10)));
      }
      node.appendChild(row);
    }
    if (!rows.length) {
      node.appendChild(
        make(
          "div",
          "empty",
          tab === "cached" ? "还没有缓存的属性。" : tab === "failed" ? "上次没有失败的条目。" : "所有条目都已经有属性缓存了。",
        ),
      );
    }
  }

  async function startAcquire() {
    const targets = tuningTargets();
    const missing = targets
      .filter((item) => !flow.tuning.index[item.key] || flow.tuning.refetch.has(item.key))
      .map((item) => ({
        matchName: item.key,
        plugin: item.plugin || "",
        category: item.category || "",
      }));
    if (!missing.length) {
      go("tuning", { force: true });
      return;
    }
    const limit = el("flowAcquireLimit");
    const rounds = el("flowAcquireRounds");
    flow.tuning.failed.clear();
    foldMissingIntoRun(missing);
    let result = null;
    try {
      result = await window.hub.startEffectDump({
        targets: missing,
        ae: flow.plan.config.ae,
        limit: limit ? Number(limit.value) || 20 : 20,
        rounds: rounds ? Number(rounds.value) || 50 : 50,
        aeGuard: aeGuardEnabled(),
      });
    } catch (error) {
      setText("flowAcquirePhase", "启动失败：" + String((error && error.message) || error));
      return;
    }
    if (!result || result.ok === false) {
      setText("flowAcquirePhase", "启动失败：" + explainStartError(result));
      return;
    }
    show("flowAcquireProgress", true);
    flow.tuning.polling = true;
    paintAcquire();
    if (!flow.tuning.pollTimer) {
      flow.tuning.pollTimer = setInterval(pollAcquire, 800);
    }
    pullAcquireState();
  }

  function foldMissingIntoRun() {
    /* 占位：批量获取目前不需要额外状态，保留接口方便以后中途改目标 */
  }

  async function pullAcquireState() {
    if (!flow.tuning.polling) return;
    let snap = null;
    try {
      snap = await window.hub.dumpSnapshot();
    } catch (_error) {
      return;
    }
    const data = snap && snap.state ? snap.state : snap;
    if (!data) return;
    const phase = String(data.phase || "");
    const total = Number(data.total) || 0;
    const current = Number(data.current) || 0;
    setText("flowAcquirePhase", phaseLabel(phase));
    setText(
      "flowAcquireCount",
      total ? "第 " + (Number(data.round) || 1) + " 批 · " + current + " / " + total : "",
    );
    setText("flowAcquireMessage", [data.currentName, data.message].filter(Boolean).join(" · "));
    const bar = el("flowAcquireBar");
    if (bar) bar.style.width = (total ? Math.round((current / total) * 100) : 0) + "%";
    if (phase === "done" || phase === "failed" || phase === "cancelled") {
      flow.tuning.polling = false;
      if (flow.tuning.pollTimer) clearInterval(flow.tuning.pollTimer);
      flow.tuning.pollTimer = null;
      await refreshParamIndex();
      if (phase === "done") {
        // 这批已经拿到新属性：解除「重新获取」标记，并让参数树重新走一次缓存
        flow.tuning.refetch.clear();
        for (const key of Array.from(flow.tuning.cache.keys())) {
          if (key.indexOf("params:") === 0) flow.tuning.cache.delete(key);
        }
      }
      paintAcquire();
      show("flowAcquireStop", false);
      const cont = el("flowAcquireContinue");
      if (cont) cont.hidden = false;
      if (phase === "done") setText("flowAcquirePhase", "属性获取完成");
    }
  }

  async function pollAcquire() {
    if (!flow.tuning.polling) {
      if (flow.tuning.pollTimer) clearInterval(flow.tuning.pollTimer);
      flow.tuning.pollTimer = null;
      return;
    }
    await pullAcquireState();
  }

  async function paintTuning() {
    await refreshParamIndex();
    paintTuningSidebar();
    if (!flow.tuning.current) {
      const first = tuningTargets()[0];
      if (first) flow.tuning.current = first.key;
    }
    await paintTuningMain();
    paintSteps();
  }

  function paintTuningSidebar() {
    const node = clear(el("flowTuneEffects"));
    if (!node) return;
    const query = flow.tuning.effectQuery.trim().toLowerCase();
    const targets = tuningTargets().filter(
      (item) => !query || item.name.toLowerCase().indexOf(query) >= 0,
    );
    const groups = new Map();
    for (const item of targets) {
      const meta = item.meta || "";
      const groupName = meta || "未分类";
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(item);
    }
    for (const [groupName, items] of Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0], "zh-CN"))) {
      node.appendChild(make("div", "flow-tune-group", groupName));
      for (const item of items) {
        const row = make("div", "flow-tune-effect");
        row.setAttribute("data-key", item.key);
        if (item.key === flow.tuning.current) row.classList.add("active");
        row.appendChild(make("span", "flow-tune-effect-name", item.name));
        const hit = flow.tuning.index[item.key];
        const changes = overrideCount(item.key);
        const badge = make("span", "flow-tune-badge " + (hit ? (changes ? "changed" : "ok") : "warn"));
        badge.textContent = hit ? (changes ? "已改动 " + changes : "已获取") : "待获取";
        row.appendChild(badge);
        row.addEventListener("click", () => {
          flow.tuning.current = item.key;
          paintTuningSidebar();
          paintTuningMain();
        });
        node.appendChild(row);
      }
    }
    if (!targets.length) node.appendChild(make("div", "empty", "没有开启人工调参的效果。"));
  }

  function overrideCount(matchName) {
    const rows = flow.tuning.cache.get(matchName);
    if (!rows) return 0;
    return rows.filter((row) => row.value != null && row.value !== "").length;
  }

  async function loadOverrides(matchName) {
    if (flow.tuning.cache.has(matchName)) return flow.tuning.cache.get(matchName);
    let rows = [];
    try {
      rows = (await window.hub.readEffectOverrides(matchName)) || [];
    } catch (_error) {
      rows = [];
    }
    const list = Array.isArray(rows)
      ? rows
      : rows && Array.isArray(rows.items)
        ? rows.items
        : rows && Array.isArray(rows.rows)
          ? rows.rows
          : [];
    flow.tuning.cache.set(matchName, list);
    return list;
  }

  async function paintTuningMain() {
    const matchName = flow.tuning.current;
    const item = tuningTargets().find((entry) => entry.key === matchName) || null;
    setText("flowTuneName", item ? item.name : "选择一个效果开始调参");
    setText("flowTuneSub", item ? item.meta || "" : "");
    show("flowTuneRefetch", !!item);
    show("flowTuneMore", !!item);
    const source = el("flowTuneSource");
    const paramsNode = clear(el("flowTuneParams"));
    if (!item) return;
    const hit = flow.tuning.index[item.key];
    if (source) {
      source.textContent = hit && hit.fetchedAt
        ? "属性来自缓存 · " + String(hit.aeVersion || "") + " · " + String(hit.fetchedAt).slice(0, 10) + " 获取"
        : "";
    }
    if (!hit) {
      if (paramsNode) {
        paramsNode.appendChild(make("div", "empty", "还没有获取这个效果的属性。"));
        const btn = make("button", "btn primary", "获取属性");
        btn.type = "button";
        btn.style.marginTop = "10px";
        btn.addEventListener("click", () => go("acquire"));
        paramsNode.appendChild(btn);
      }
      return;
    }
    const data = await loadParams(item.key);
    if (!data) {
      if (paramsNode) paramsNode.appendChild(make("div", "empty", "属性读取失败，可以点「重新获取」再试一次。"));
      return;
    }
    await loadOverrides(item.key);
    flow.tuning.raw.set(item.key, data.params || []);
    renderParamTree(paramsNode, data.params || []);
  }

  async function loadParams(matchName) {
    if (flow.tuning.cache.has("params:" + matchName)) return flow.tuning.cache.get("params:" + matchName);
    try {
      const data = await window.hub.getEffectParams(matchName);
      if (!data || data.ok === false) return null;
      flow.tuning.cache.set("params:" + matchName, data);
      return data;
    } catch (_error) {
      return null;
    }
  }

  function overrideValue(matchName, indexPath) {
    const rows = flow.tuning.cache.get(matchName) || [];
    const hit = rows.find((row) => row.indexPath === indexPath || row.path === indexPath);
    return hit ? hit.value : "";
  }

  function renderParamTree(node, params) {
    if (!node) return;
    node.textContent = "";
    const matchName = flow.tuning.current;
    const query = flow.tuning.paramQuery.trim().toLowerCase();
    const onlyChanged = flow.tuning.onlyChanged;
    const groups = new Map();
    for (const param of params) {
      const groupName = String(param.group || "");
      if (!groups.has(groupName)) groups.set(groupName, []);
      groups.get(groupName).push(param);
    }
    const writable = params.filter((param) => param.type !== "Group");
    const readonly = writable.filter((param) => param.readOnly);
    let shown = 0;
    for (const [groupName, list] of groups.entries()) {
      const visible = list.filter((param) => {
        if (param.type === "Group") return false;
        if (param.readOnly) return false;
        if (query) {
          const haystack = [param.name, param.path, param.indexPath].filter(Boolean).join(" ").toLowerCase();
          if (haystack.indexOf(query) < 0) return false;
        }
        if (onlyChanged && !String(overrideValue(matchName, param.indexPath) || "").length) return false;
        return true;
      });
      if (!visible.length) continue;
      /* 单独一层的顶层参数不套组标题：group 名就是参数名，套了会重复显示两遍 */
      if (visible.length === 1 && Number(visible[0].depth) < 2) {
        shown++;
        node.appendChild(tuneRow(visible[0], matchName, node, params));
        continue;
      }
      const collapsed = flow.tuning.collapsed.has(groupName);
      const group = make("div", "tune-group");
      const head = make("div", "tune-group-head" + (collapsed ? " collapsed" : ""));
      head.appendChild(make("span", "tune-group-caret", "▾"));
      head.appendChild(make("span", "tune-group-name", groupName || "参数"));
      const changed = visible.filter((param) => String(overrideValue(matchName, param.indexPath) || "").length).length;
      if (changed) head.appendChild(make("span", "tune-group-count", String(changed)));
      head.addEventListener("click", () => {
        if (collapsed) flow.tuning.collapsed.delete(groupName);
        else flow.tuning.collapsed.add(groupName);
        renderParamTree(node, params);
      });
      group.appendChild(head);
      if (!collapsed) {
        for (const param of visible) {
          shown++;
          group.appendChild(tuneRow(param, matchName, node, params));
        }
      }
      node.appendChild(group);
    }
    if (!shown) node.appendChild(make("div", "empty", onlyChanged ? "没有已改动的参数。" : "没有匹配的参数。"));
    if (readonly.length) {
      const more = make("div", "tune-more", "其它参数（只读，" + readonly.length + " 项）");
      more.addEventListener("click", () => {
        readonly.forEach((param) => node.appendChild(tuneRow(param, matchName, node, params, true)));
        more.remove();
      });
      node.appendChild(more);
    }
  }

  function tuneRow(param, matchName, treeNode, allParams, readOnlyHint) {
    const row = make("div", "tune-row");
    const current = overrideValue(matchName, param.indexPath);
    if (String(current || "").length) row.classList.add("changed");
    const rawLabel = String(param.name || param.path || "").trim();
    let label = rawLabel || "参数 " + String(param.indexPath || "?");
    /* 同名参数（BCC 这类插件里很常见）补一个索引后缀才能区分 */
    if (rawLabel) {
      const dupCount = (Array.isArray(allParams) ? allParams : []).filter(
        (other) => other && other.indexPath !== param.indexPath && String(other.name || other.path || "").trim() === rawLabel,
      ).length;
      if (dupCount > 0) label += " · #" + String(param.indexPath);
    }
    const name = make("div", "tune-row-name", label);
    const depth = Number(param.depth) || 0;
    if (depth === 1) name.classList.add("depth1");
    if (depth >= 2) name.classList.add("depth2");
    row.appendChild(name);
    row.appendChild(make("div", "tune-row-type", typeLabel(param)));
    row.appendChild(make("div", "tune-row-cur", String(param.valueText != null ? param.valueText : param.value == null ? "" : param.value)));
    const input = document.createElement("input");
    input.className = "input tune-row-input";
    input.type = "text";
    input.value = current == null ? "" : String(current);
    input.placeholder = param.valueText != null ? String(param.valueText) : "";
    if (param.readOnly || readOnlyHint) input.disabled = true;
    input.addEventListener("change", () => {
      setOverride(matchName, param, input.value.trim(), treeNode, allParams);
    });
    row.appendChild(input);
    row.appendChild(make("div", "tune-row-range", rangeLabel(param)));
    const clearBtn = make("button", "tune-row-clear", "×");
    clearBtn.type = "button";
    clearBtn.title = "清除这条覆盖";
    clearBtn.addEventListener("click", () => {
      input.value = "";
      setOverride(matchName, param, "", treeNode, allParams);
    });
    row.appendChild(clearBtn);
    return row;
  }

  function typeLabel(param) {
    const type = String(param.type || "");
    const map = { OneD: "数值", Slider: "滑杆", Checkbox: "开关", Color: "颜色", Text: "文本", Menu: "菜单", Point: "点", Angle: "角度" };
    return map[type] || type || "—";
  }

  function rangeLabel(param) {
    if (param.hasMin && param.hasMax) return fmtNum(param.min) + " ~ " + fmtNum(param.max);
    if (param.hasMin) return "≥ " + fmtNum(param.min);
    if (param.hasMax) return "≤ " + fmtNum(param.max);
    return "";
  }
  function fmtNum(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return String(value == null ? "" : value);
    return String(Math.round(num * 1000) / 1000);
  }

  function setOverride(matchName, param, value, treeNode, allParams) {
    const rows = flow.tuning.cache.get(matchName) || [];
    const indexPath = param.indexPath;
    const index = rows.findIndex((row) => row.indexPath === indexPath);
    const clean = value === "" ? "" : String(value);
    if (clean === "") {
      if (index >= 0) rows.splice(index, 1);
    } else if (index >= 0) {
      rows[index] = Object.assign({}, rows[index], { value: clean, verified: null });
    } else {
      rows.push({
        indexPath: indexPath,
        path: String(param.path || ""),
        name: String(param.name || ""),
        value: clean,
        valueType: String(param.valueType || ""),
        verified: null,
      });
    }
    flow.tuning.cache.set(matchName, rows);
    renderParamTree(treeNode, allParams);
    flushOverrides(matchName);
  }

  const saveTimers = new Map();
  function flushOverrides(matchName) {
    if (saveTimers.has(matchName)) clearTimeout(saveTimers.get(matchName));
    const timer = setTimeout(async () => {
      saveTimers.delete(matchName);
      const rows = flow.tuning.cache.get(matchName) || [];
      try {
        await window.hub.writeEffectOverrides({ matchName, entries: rows });
        setText("flowTuneSaved", "已保存 " + nowClock());
        if (flow.step === "tuning") paintTuningSidebar();
      } catch (error) {
        setText("flowTuneSaved", "保存失败：" + String((error && error.message) || error));
      }
    }, 350);
    saveTimers.set(matchName, timer);
  }

  async function verifyTuning() {
    const matchName = flow.tuning.current;
    if (!matchName) return;
    const rows = flow.tuning.cache.get(matchName) || [];
    setText("flowTuneSaved", "正在启动 AE 验证…");
    try {
      const result = await window.hub.verifyEffectParams({
        matchName,
        params: rows,
        ae: flow.plan.config.ae,
        aeGuard: aeGuardEnabled(),
      });
      const diff = el("flowTuneDiff");
      const compare = result && result.compare ? result.compare : result;
      if (result && result.ok && compare && compare.ok && diff) {
        diff.hidden = false;
        const base = el("flowTuneBaseImg");
        const verify = el("flowTuneVerifyImg");
        if (base && compare.baselineDataUrl) base.src = compare.baselineDataUrl;
        if (verify && compare.verifyDataUrl) verify.src = compare.verifyDataUrl;
        setText(
          "flowTuneDiffText",
          compare.identical
            ? "与基线一致（参数写入后画面未变化，已标记为未生效）"
            : "写入已改变画面：差异 " + compare.diffPixels + " 像素（最大通道差 " + compare.maxChannelDiff + "）",
        );
        const verified = !compare.identical;
        for (const row of rows) row.verified = verified;
        flow.tuning.cache.set(matchName, rows);
        await window.hub.writeEffectOverrides({ matchName, entries: rows });
        setText("flowTuneSaved", verified ? "验证通过并已保存" : "已记录为未生效");
      } else {
        setText("flowTuneDiffText", (result && (result.message || result.reason)) || "验证失败");
        if (diff) diff.hidden = false;
      }
    } catch (error) {
      setText("flowTuneSaved", "验证失败：" + String((error && error.message) || error));
    }
  }

  async function resetEffectOverrides() {
    const matchName = flow.tuning.current;
    if (!matchName) return;
    if (!window.confirm("清空这个效果的全部覆盖值？")) return;
    flow.tuning.cache.set(matchName, []);
    try {
      await window.hub.writeEffectOverrides({ matchName, entries: [] });
    } catch (_error) {
      /* 忽略 */
    }
    const node = el("flowTuneParams");
    const params = flow.tuning.raw.get(matchName) || [];
    if (node) renderParamTree(node, params);
    paintTuningSidebar();
    setText("flowTuneSaved", "已清空 " + nowClock());
  }

  function refetchCurrent() {
    const matchName = flow.tuning.current;
    if (!matchName) return;
    flow.tuning.refetch.add(matchName);
    delete flow.tuning.index[matchName];
    flow.tuning.cache.delete("params:" + matchName);
    setText("flowTuneSaved", "已标记重新获取，进入获取步骤…");
    flow.tuning.tab = "todo";
    go("acquire");
  }

  async function acquireAllFromTuning() {
    flow.tuning.tab = "todo";
    go("acquire");
  }

  /* ---------------- 日志弹窗 ---------------- */

  function openLogDialog(title, text) {
    const dialog = el("renderLogDialog");
    if (!dialog) return;
    setText("renderLogTitle", title);
    setText("renderLogSubtitle", "最近输出");
    const body = el("renderLogBody");
    if (body) body.textContent = text || "（暂无日志）";
    dialog.hidden = false;
  }

  async function openRunLog() {
    try {
      const text =
        flow.kind === "preset"
          ? await window.hub.logTail(400)
          : await window.hub.logPluginEffectsTail(400);
      openLogDialog(flow.kind === "preset" ? "预设渲染日志" : "插件效果渲染日志", text);
    } catch (_error) {
      openLogDialog("日志", "读取失败");
    }
  }

  async function openDumpLog() {
    try {
      const text = window.hub.logDumpTail ? await window.hub.logDumpTail(400) : "";
      openLogDialog("属性获取日志", text);
    } catch (_error) {
      openLogDialog("属性获取日志", "读取失败");
    }
  }

  /* ---------------- 从库进入 ---------------- */

  function resetPlan() {
    flow.plan.items = [];
    flow.plan.config.force = false;
    flow.resultRows = [];
    flow.tuning.current = "";
    flow.tuning.cache.clear();
    flow.tuning.raw.clear();
    flow.tuning.index = {};
  }

  function enterFromLibrary(kind, payload) {
    const data = payload || {};
    const items = Array.isArray(data.items) ? data.items : [];
    resetPlan();
    flow.kind = kind === "effect" ? "effect" : "preset";
    flow.plan.config.limit = flow.kind === "effect" ? 8 : 40;
    flow.plan.config.rounds = flow.kind === "effect" ? 200 : 40;
    const saved = loadConfig();
    if (saved && saved.kind === flow.kind && saved.config) {
      flow.plan.config = Object.assign({}, flow.plan.config, saved.config);
    }
    for (const item of items) {
      const key = String(item.key || item.matchName || item.path || "");
      if (!key) continue;
      flow.plan.items.push({
        key,
        kind: flow.kind,
        name: String(item.name || key),
        meta: String(item.meta || ""),
        status: String(item.status || "pending"),
        reason: String(item.reason || ""),
        manualTuning: !!(item.manualTuning || data.manualTuning),
        presetPath: String(item.presetPath || (flow.kind === "preset" ? key : "")),
        matchName: String(item.matchName || (flow.kind === "effect" ? key : "")),
        plugin: String(item.plugin || ""),
        category: String(item.category || ""),
      });
    }
    flow.entry = data.entry || { view: flow.kind === "effect" ? "effects" : "presets" };
    flow.reached = new Set(["type", "select", "confirm"]);
    resetTuningDone();
    if (typeof setView === "function") setView("render");
    if (data.manualTuning && flow.plan.items.length === 1 && flow.kind === "effect") {
      flow.tuning.active = true;
      go("confirm");
      paintConfirm();
      /* 直接展开调参：缓存命中就进 3b，否则先进 3a */
      (async () => {
        await refreshParamIndex();
        const hit = flow.tuning.index[flow.plan.items[0].key];
        flow.tuning.current = flow.plan.items[0].key;
        go(hit ? "tuning" : "acquire", { force: true });
      })();
      return;
    }
    go("confirm");
  }

  function backToLibrary() {
    const view = flow.entry && flow.entry.view ? flow.entry.view : flow.kind === "effect" ? "effects" : "presets";
    flow.entry = null;
    if (typeof setView === "function") setView(view);
    paintSteps();
  }

  /* ---------------- 恢复运行中的渲染 ---------------- */

  async function restoreRunningJob() {
    /* renderSnapshot / pluginEffectsSnapshot 只返回状态文件内容，
       进程是否在跑要问主进程的 snapshot（render.running / pluginEffects.running）。 */
    let host = null;
    try {
      host = await window.hub.snapshot();
    } catch (_error) {
      host = null;
    }
    if (!host) return false;
    const presetRunning = !!(host.render && host.render.running);
    const effectJob = host.pluginEffects || {};
    const effectRunning = !!effectJob.running && effectJob.mode !== "catalog";
    if (!presetRunning && !effectRunning) return false;
    flow.kind = effectRunning ? "effect" : "preset";
    flow.reached = new Set(["type", "select", "confirm", "run"]);
    go("run", { force: true });
    const lastState = effectRunning ? effectJob.state : host.render.state;
    applyRunState(lastState);
    startRunPolling();
    return true;
  }

  /* ---------------- 事件绑定 ---------------- */

  function on(id, event, handler) {
    const node = el(id);
    if (node) node.addEventListener(event, handler);
  }

  function bindFlow() {
    on("flowKindPreset", "click", () => chooseKind("preset"));
    on("flowKindEffect", "click", () => chooseKind("effect"));

    on("flowSelectSearch", "input", (event) => {
      flow.selection.query = event.target.value || "";
      paintSelection();
    });
    on("flowSelectFilterA", "change", (event) => {
      flow.selection.filterA = event.target.value;
      paintSelection();
    });
    on("flowSelectFilterB", "change", (event) => {
      flow.selection.filterB = event.target.value;
      paintSelection();
    });
    on("flowSelectHide", "change", (event) => {
      flow.selection.hideRendered = !!event.target.checked;
      paintSelection();
    });
    on("flowSelectAll", "click", selectAllFiltered);
    on("flowSelectClear", "click", () => {
      flow.plan.items = [];
      paintSelection();
    });
    on("flowSelectBack", "click", () => go("type"));
    on("flowSelectNext", "click", () => {
      if (!flow.plan.items.length) return;
      go("confirm", { force: true });
    });

    on("flowConfirmBack", "click", () => go("select"));
    on("flowConfirmNext", "click", startFromConfirm);
    on("flowConfirmRetune", "click", reopenTuning);
    on("flowBackground", "change", async (event) => {
      const select = event.target;
      if (select.value !== "__custom__") {
        flow.plan.config.background = select.value;
        return;
      }
      select.value = flow.plan.config.background || "photo";
      const result = await window.hub.addBackground();
      const added = (result && result.added) || [];
      const errors = (result && result.errors) || [];
      if (!added.length) {
        setStatus(errors.length ? "图片无法解码为 PNG，未添加背景" : "未添加背景", true);
        return;
      }
      flow.plan.config.background = added[0];
      await fillBackgroundSelect();
      select.value = added[0];
      setStatus(
        "已转换为 PNG：" +
          String(added[0]).split(/[\\/]/).pop() +
          (errors.length ? "；" + errors.length + " 个文件失败" : ""),
      );
    });
    on("flowAeGuard", "change", (event) => setAeGuardEnabled(!!event.target.checked));
    on("flowAcquireGuard", "change", (event) => setAeGuardEnabled(!!event.target.checked));

    on("flowAcquireStart", "click", startAcquire);
    on("flowAcquireStop", "click", () => {
      try {
        window.hub.stopEffectDump();
      } catch (_error) {
        /* 忽略 */
      }
    });
    on("flowAcquireLog", "click", openDumpLog);
    on("flowAcquireContinue", "click", () => go("tuning", { force: true }));
    on("flowAcquireSkip", "click", () => go("tuning", { force: true }));
    const tabs = document.querySelectorAll("#flowAcquireTabs .seg");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        flow.tuning.tab = tab.getAttribute("data-acq-tab") || "todo";
        tabs.forEach((other) => other.classList.toggle("active", other === tab));
        paintAcquire();
      });
    });

    on("flowTuneSearch", "input", (event) => {
      flow.tuning.effectQuery = event.target.value || "";
      paintTuningSidebar();
    });
    on("flowTuneParamSearch", "input", (event) => {
      flow.tuning.paramQuery = event.target.value || "";
      const node = el("flowTuneParams");
      const params = flow.tuning.raw.get(flow.tuning.current) || [];
      if (node) renderParamTree(node, params);
    });
    on("flowTuneOnlyChanged", "change", (event) => {
      flow.tuning.onlyChanged = !!event.target.checked;
      const node = el("flowTuneParams");
      const params = flow.tuning.raw.get(flow.tuning.current) || [];
      if (node) renderParamTree(node, params);
    });
    on("flowTuneExpandAll", "click", () => {
      flow.tuning.collapsed.clear();
      const node = el("flowTuneParams");
      const params = flow.tuning.raw.get(flow.tuning.current) || [];
      if (node) renderParamTree(node, params);
    });
    on("flowTuneResetEffect", "click", resetEffectOverrides);
    on("flowTuneAcquireAll", "click", acquireAllFromTuning);
    on("flowTuneVerify", "click", verifyTuning);
    on("flowTuneRefetch", "click", refetchCurrent);
    on("flowTuneMore", "click", resetEffectOverrides);
    on("flowTuneDone", "click", () => {
      flow.tuning.active = false;
      flow.tuning.done = true;
      flow.tuning.doneAt = nowClock();
      go("confirm");
    });

    on("flowRunStop", "click", stopRun);
    on("flowRunLogOpen", "click", openRunLog);

    on("flowResultExit", "click", backToLibrary);
    on("flowResultBack", "click", () => go("confirm"));
    on("flowResultRetry", "click", retryFailed);

    on("flowLibBack", "click", backToLibrary);

    const stepNodes = document.querySelectorAll("#flowSteps .flow-step-item");
    stepNodes.forEach((node) => {
      node.addEventListener("click", () => {
        if (node.getAttribute("data-reached") !== "1") return;
        if (flow.run.polling) return;
        const step = node.getAttribute("data-flow-step");
        if (step) requestStep(step);
      });
    });

    /* 顶栏切到「预览渲染」时刷新计数 */
    document.addEventListener(
      "click",
      (event) => {
        const tab = event.target && event.target.closest ? event.target.closest("#tabs .tab") : null;
        if (!tab) return;
        if (tab.getAttribute("data-view") === "render") onShow();
      },
      true,
    );
  }

  async function onShow() {
    paintKinds();
    if (flow.step === "type") return;
    if (flow.step === "select") paintSelection();
    if (flow.step === "confirm") paintConfirm();
    if (flow.step === "acquire") paintAcquire();
    if (flow.step === "tuning") paintTuning();
    if (flow.step === "result") paintResult();
    if (flow.step === "run" && !flow.run.polling) {
      const restored = await restoreRunningJob();
      if (!restored) paintRun();
    }
  }

  async function boot() {
    bindFlow();
    flow.selection.hideRendered = false;
    const saved = loadConfig();
    if (saved && (saved.kind === "preset" || saved.kind === "effect")) flow.kind = saved.kind;
    if (saved && saved.config) flow.plan.config = Object.assign({}, flow.plan.config, saved.config);
    paintKinds();
    await fillBackgroundSelect();
    go("type", { force: true });
    await restoreRunningJob();
  }

  window.PreviewFlow = {
    show: onShow,
    enterFromLibrary,
    goToStep: (step, options) => {
      if (options && options.force) {
        flow.reached.add(step);
        go(step, { force: true });
        return;
      }
      requestStep(step);
    },
    current: () => ({ step: flow.step, kind: flow.kind, plan: flow.plan, reached: Array.from(flow.reached) }),
    isBusy: isAnyRunning,
    aeGuardEnabled,
    setAeGuardEnabled,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
