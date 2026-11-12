var AEV_ViewModel = (function () {
  function trimText(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/^\s+|\s+$/g, "");
  }

  /* 表达式控件族与音频族不渲图，面板退化为文字条目（设计文档 §4.3） */
  var NO_PREVIEW_CATEGORIES = [
    "expression controls",
    "表达式控制",
    "audio",
    "音频"
  ];

  /* 这些分类即使渲出来也基本看不出效果：需要 3D 场景、立体素材或音频输入。
     实测踩过：按 catalog 原始顺序取候选，第一屏全是 ADBE 3D Tracker / 3D Glasses，
     8 个预览里 6 个与原始素材几乎无差别。 */
  var POOR_PREVIEW_CATEGORIES = [
    "3d channel",
    "3d 通道"
  ];

  /* 常用且视觉差异明显的分类，越靠前越优先生成 */
  var PREFERRED_CATEGORIES = [
    "blur & sharpen",
    "模糊和锐化",
    "color correction",
    "颜色校正",
    "distort",
    "扭曲",
    "stylize",
    "风格化",
    "generate",
    "生成",
    "noise & grain",
    "杂色和颗粒",
    "perspective",
    "透视",
    "transition",
    "过渡",
    "keying",
    "抠像",
    "simulation",
    "模拟",
    "channel",
    "声道",
    "time",
    "时间",
    "utility",
    "实用工具",
    "matte",
    "遮罩"
  ];

  function normalize(value) {
    return String(value === undefined || value === null ? "" : value).toLowerCase();
  }

  function indexOfText(list, value) {
    for (var i = 0; i < list.length; i++) {
      if (list[i] === value) return i;
    }
    return -1;
  }

  function isNoPreview(category) {
    var cat = normalize(category);
    return indexOfText(NO_PREVIEW_CATEGORIES, cat) >= 0;
  }

  /** 需要 3D 场景/立体素材才成立的效果，列入"不主动生成" */
  function isPoorPreviewTarget(effect) {
    var cat = normalize(effect && effect.category);
    if (indexOfText(POOR_PREVIEW_CATEGORIES, cat) >= 0) return true;
    var matchName = normalize(effect && effect.matchName);
    // 音频族：AE 2021 里有一批以 Aud 开头的效果（AudWave 音频波形、AudSpect 音频频谱…），
    // 它们的分类字段常常是空的，按名字认更准。
    // 实测：ADBE AudWave 一渲染就挂死——无音频输入时音频效果没法求值。
    if (/^adbe aud/.test(matchName)) return true;
    // CS 前缀是本机 Cycore 旧命名残留（displayName 与 CC 系列重名）。
    // 实测：CS CrossBlur 参与整网渲染时报「滤镜无效」，整批随之失败。
    // 这 10 个先整体排除，等隔离探针逐个确认后再决定是否恢复。
    if (matchName.indexOf("cs") === 0) return true;
    // 实测：CC Drizzle 在 2048 整网 × 6 帧下渲染挂起（AE 未响应超过 5 分钟），
    // 逐条测试时也会卡在同一处。先排除，避免单条拖死整批。
    if (matchName === "cc drizzle") return true;
    // 实测：ADBE Upscale（放大）一渲染 AE 就挂死（逐条排查定位）
    if (matchName === "adbe upscale") return true;
    // 实测：ADBE Fractal（分形）一渲染 AE 就挂死（逐条排查定位）
    if (matchName === "adbe fractal") return true;
    // 实测：ADBE Tile（平铺）一渲染 AE 就挂死（逐条排查定位）
    if (matchName === "adbe tile") return true;
    // 实测：ADBE Echo（残影）一渲染 AE 就挂死（逐条排查定位）
    if (matchName === "adbe echo") return true;
    // 实测：CC Hair 是毛发模拟，静态渲勉强能过，但给参数打上关键帧后
    // 每帧都要重新模拟，AE 直接挂死被终止（逐条排查定位到的元凶）。
    if (matchName === "cc hair") return true;
    // 实测：ADBE Numbers2 / Timecode 这类"文本生成器"在 addProperty 时就会弹出
    // 模态参数对话框（编号设置），脚本会一直等输入，AE 看起来像死机。
    if (/^adbe (numbers|timecode)/.test(matchName)) return true;
    // 实测：ADBE Apply Color LUT2 在渲染阶段弹出「选择 LUT 文件」对话框，
    // 整批渲染卡死在同一格（逐格排查时定位到它）。
    if (matchName.indexOf("apply color lut") >= 0) return true;
    // CINEMA 4D / Element 3D：依赖外部渲染器，AE 会挂住不动
    // （实测 "CINEMA 4D Effect" 一渲染就卡死，AE 进程还在但永远不返回）
    if (matchName.indexOf("cinema 4d") === 0 || matchName.indexOf("element 3d") === 0) {
      return true;
    }
    if (cat.indexOf("cinema 4d") >= 0 || cat.indexOf("element 3d") >= 0) {
      return true;
    }
    var hints = ["tracker", "glasses", "stereo", "camera", "extracto"];
    for (var i = 0; i < hints.length; i++) {
      if (matchName.indexOf(hints[i]) >= 0) return true;
    }
    return false;
  }

  /**
   * 判定一个效果被整体排除的原因键（空串 = 不排除）。
   *
   * 合并了三处判断（面板、离线清单生成、批量渲染共用这一份）：
   *   · "Pseudo/" 占位项                     -> "pseudo"
   *   · 已过时（_Obsolete / 过时）            -> "obsolete"
   *   · AE 里没有分类的效果（分类字段为空）   -> "no_category"
   *     —— 它们在 AE 菜单里没有归属，预览墙的左侧分类栏也放不下，
   *        只能落进「未分类」这一堆，没有意义
   *   · 渲不出有意义结果的一批               -> "poor_preview"
   *     （3D 通道、弹框类、挂起类、CS 旧命名）
   *
   * 原因键同时写进 AE 侧扫描出的 plugin_effect_catalog.tsv，Hub 用它给
   * 不可选行显示原因，所以键名是接口的一部分，不要改。
   */
  function excludeReason(effect) {
    var matchName = String((effect && effect.matchName) || "");
    var category = String((effect && effect.category) || "");
    if (matchName.indexOf("Pseudo/") === 0) return "pseudo";
    if (/Obsolete|过时/i.test(category)) return "obsolete";
    // AE 对一批效果不返回分类（实测 97 个，多是 ADBE CM * 与 3D 通道族）。
    // 用户明确要求「未分类的效果不要」，这里直接排除。
    if (!trimText(category)) return "no_category";
    if (isPoorPreviewTarget(effect)) return "poor_preview";
    return "";
  }

  /** 一个效果是否应当被整体排除（保持旧行为：等价于 excludeReason 非空） */
  function isExcludable(effect) {
    return excludeReason(effect) !== "";
  }

  /** 生成优先级：数值越小越先渲 */
  function previewRank(effect) {
    if (isPoorPreviewTarget(effect)) return 1000;
    var cat = normalize(effect && effect.category);
    var idx = indexOfText(PREFERRED_CATEGORIES, cat);
    return idx >= 0 ? idx : 500;
  }

  /** 按分类轮转排列候选。
   *  纯按 rank 排序会让首批 64 个全是"模糊和锐化"，预览墙看起来毫无多样性；
   *  轮转后首批就能覆盖模糊/调色/扭曲/风格化等多个类别。
   */
  function interleaveByCategory(effects) {
    var buckets = {};
    var order = [];
    for (var i = 0; i < effects.length; i++) {
      var effect = effects[i];
      var cat = normalize(effect && effect.category) || "未分类";
      if (!buckets[cat]) {
        buckets[cat] = [];
        order.push(cat);
      }
      buckets[cat].push(effect);
    }

    order.sort(function (a, b) {
      var rankA = previewRank(buckets[a][0]);
      var rankB = previewRank(buckets[b][0]);
      if (rankA !== rankB) return rankA - rankB;
      return buckets[b].length - buckets[a].length;
    });

    var out = [];
    var cursors = {};
    var progressed = true;
    while (progressed) {
      progressed = false;
      for (var k = 0; k < order.length; k++) {
        var key = order[k];
        var cursor = cursors[key] || 0;
        if (cursor < buckets[key].length) {
          out.push(buckets[key][cursor]);
          cursors[key] = cursor + 1;
          progressed = true;
        }
      }
    }
    return out;
  }

  /**
   * 分类键：直接用 AE 的原始分类名。
   * 用原始串而不是显示名做键，切换语言时筛选状态才不会失效
   * （中文 AE 的分类是「模糊和锐化」，英文 AE 是「Blur & Sharpen」，
   * 但它们指的是同一个分类，显示名要走 names.json 映射）。
   */
  function categoryKey(item) {
    var raw = trimText((item && item.category) || "");
    return raw || "未分类";
  }

  /** 分类的显示名：优先用名字表里的双语分类，其次用本机分类名 */
  function categoryLabel(item, lang) {
    var resolved = resolveCategory(item, lang);
    if (resolved) return resolved;
    return categoryKey(item);
  }

  /**
   * 分类的先后顺序：按 AE 菜单里首次出现的顺序。
   * 从 catalog 推导而不是写死表——AE 的界面语言不同，分类名就不同，
   * 写死的表在另一种语言的 AE 上对不上。
   */
  function categoryOrder(catalog) {
    var seen = [];
    var known = {};
    for (var i = 0; i < catalog.length; i++) {
      var key = categoryKey(catalog[i]);
      if (!known[key]) {
        known[key] = true;
        seen.push(key);
      }
    }
    return seen;
  }

  /**
   * 排序。
   * mode = "name"     按名称首字母（中文按拼音，英文按字母）
   * mode = "category" 先按 AE 分类，分类内再按名称
   */
  function sortItems(items, mode, lang) {
    var locale = lang === "zh" ? "zh-Hans-CN" : "en";
    var copy = [];
    for (var i = 0; i < items.length; i++) copy.push(items[i]);
    copy.sort(function (a, b) {
      if (mode === "category") {
        var ca = categoryLabel(a, lang);
        var cb = categoryLabel(b, lang);
        if (ca !== cb) {
          var byCategory = ca.localeCompare(cb, locale);
          if (byCategory !== 0) return byCategory;
        }
      }
      var na = resolveName(a, lang);
      var nb = resolveName(b, lang);
      if (na !== nb) {
        var byName = na.localeCompare(nb, locale);
        if (byName !== 0) return byName;
      }
      return String(a.matchName).localeCompare(String(b.matchName), locale);
    });
    return copy;
  }

  /** 统计各分类的条目数（用于侧栏） */
  function categoryCounts(items, lang) {
    var counts = {};
    var labels = {};
    for (var i = 0; i < items.length; i++) {
      var key = categoryKey(items[i]);
      counts[key] = (counts[key] || 0) + 1;
      if (!labels[key]) labels[key] = categoryLabel(items[i], lang);
    }
    return { counts: counts, labels: labels };
  }

  function firstText() {
    for (var i = 0; i < arguments.length; i++) {
      var value = arguments[i];
      if (value !== null && value !== undefined && String(value).length > 0) {
        return String(value);
      }
    }
    return "";
  }

  function resolveName(item, lang) {
    if (lang === "zh") {
      return firstText(item.nameZh, item.nameEn, item.displayName, item.matchName);
    }
    return firstText(item.nameEn, item.displayName, item.nameZh, item.matchName);
  }

  function resolveCategory(item, lang) {
    if (lang === "zh") {
      return firstText(item.categoryZh, item.categoryEn, item.category, "未分类");
    }
    return firstText(item.categoryEn, item.category, item.categoryZh, "Uncategorized");
  }

  /**
   * 计算 sprite 切片参数。
   *
   * 为什么不用固定像素：缩略框的实际渲染宽度随面板宽度变化（132px 到几百 px），
   * 而整张网是固定像素尺寸。用 `background-size: 1024px` + `background-position: -x -y`
   * 的话，缩略框一旦大于格子尺寸（128px），就会把相邻格子的画面带进来。
   *
   * 改用百分比：
   *   background-size     = 每行格数 × 100%（横向）、每列格数 × 100%（纵向）
   *   background-position = 格位在整网中的百分比偏移
   * 这样无论缩略框渲染成多大，**一格永远精确等于一个缩略框**，不会串格。
   *
   * 返回 { size: "...", position: "..." }，可直接写进 style。
   */
  function spriteSlice(preview, manifest) {
    // L1 是 8×8 整网，布局取自全局 manifest；插件 L2 预览是 1×1 单格图，
    // 布局写在条目自身的 slice* 字段里。
    // 不能读 item.width/height：L1 那两个字段是「格子尺寸」而非整图尺寸，
    // 拿它当整图会把 rows 算成 1，所有非首格条目都被切到 (0,0)。
    var cellSize =
      (preview && preview.sliceCellSize) || (manifest && manifest.cellSize) || 720;
    var columns =
      (preview && preview.sliceColumns) || (manifest && manifest.columns) || 8;
    var width =
      (preview && preview.sliceWidth) ||
      (manifest && manifest.width) ||
      cellSize * columns;
    var height =
      (preview && preview.sliceHeight) ||
      (manifest && manifest.height) ||
      cellSize * columns;
    var rows = Math.max(1, Math.round(height / cellSize));

    var x = (preview && preview.x) || 0;
    var y = (preview && preview.y) || 0;

    // 整网被放大到「格数 × 100%」，一格就正好是缩略框的 1/格数
    var size =
      (columns * 100).toFixed(4) + "% " + (rows * 100).toFixed(4) + "%";

    // 百分比定位：偏移量 = 百分比 × (容器尺寸 - 图片尺寸)。
    // 图片放大后比容器大很多，所以要用 (格数-1) 而不是格数来归一。
    var posX = 0;
    var posY = 0;
    if (columns > 1) {
      posX = ((x / cellSize) / (columns - 1)) * 100;
    }
    if (rows > 1) {
      posY = ((y / cellSize) / (rows - 1)) * 100;
    }

    return {
      size: size,
      position: posX.toFixed(4) + "% " + posY.toFixed(4) + "%"
    };
  }

  /**
   * 是否 AE 自带效果。
   *
   * 用 matchName 前缀判定，而不是 inferPlugin 的显示结果：插件厂商会把自己的
   * category 写成中文分类名（「杂色和颗粒」「沉浸式视频」等），按分类判断会把
   * 插件误认成内置。内置效果的 matchName 只有 ADBE / APC / CC / CS 四种前缀
   * （T0.1 实测 1371 条枚举的分布，CS 是 Cycore 旧命名残留）。
   *
   * 这条判断是插件预览的安全边界：内置可以进整网混渲，插件必须逐条隔离。
   */
  function isBuiltinEffect(item) {
    var matchName = String((item && item.matchName) || "");
    return (
      matchName.indexOf("ADBE") === 0 ||
      matchName.indexOf("APC") === 0 ||
      matchName.indexOf("CC ") === 0 ||
      matchName.indexOf("CS") === 0
    );
  }

  function inferPlugin(item) {
    var matchName = String(item.matchName || "");
    var category = String(item.category || "");

    if (category.indexOf("BCC") === 0 || matchName.indexOf("BCC") === 0) return "BCC";
    if (
      matchName.indexOf("S_") === 0 ||
      category.indexOf("Sapphire") === 0
    ) return "Sapphire";
    if (
      matchName.indexOf("RG") === 0 ||
      category.indexOf("RG ") === 0
    ) return "Red Giant";
    if (
      matchName.indexOf("RE:") === 0 ||
      category.indexOf("RE:Vision") === 0
    ) return "RE:Vision";
    if (
      matchName.indexOf("Videocopilot") === 0 ||
      matchName.indexOf("VIDEOCOPILOT") === 0 ||
      category === "Video Copilot"
    ) return "Video Copilot";
    if (isBuiltinEffect(item)) return "内置";

    // 没落到已知插件包的第三方效果：category 常常是厂商自造的分类名
    // （「杂色和颗粒」「沉浸式视频」…），拿它当「插件名」会误导筛选。
    // 统一归到「其它插件」，让来源筛选没有漏网条目。
    return "其它插件";
  }

  function buildItem(effect, namesByName, previewByMatchName, staleByName) {
    var nameRecord = namesByName[effect.matchName] || {};
    var preview = previewByMatchName[effect.matchName] || null;
    var hasPreview = !!(preview && (preview.src || preview.frameSrc));
    return {
      matchName: effect.matchName,
      displayName: effect.displayName,
      category: effect.category,
      categoryZh: nameRecord.categoryZh,
      categoryEn: nameRecord.categoryEn,
      nameZh: nameRecord.nameZh,
      nameEn: nameRecord.nameEn,
      plugin: inferPlugin(effect),
      hasPreview: hasPreview,
      // 图还在，但配方/素材变了 —— 继续显示旧图，同时排进下一次生成
      stale: !!(hasPreview && staleByName && staleByName[effect.matchName]),
      preview: preview
    };
  }

  /** 同一效果存在多个预览时，使用合并索引中最后一个有效条目。 */
  function choosePreview(variants) {
    var selected = null;
    var rows = variants || [];
    for (var i = 0; i < rows.length; i++) {
      var preview = rows[i];
      if (!preview || !(preview.src || preview.frameSrc)) continue;
      selected = preview;
    }
    return selected;
  }

  function filterItems(items, state) {
    var lang = state.lang || "zh";
    var query = String(state.query || "").toLowerCase();
    var plugin = state.plugin || "全部";
    var output = [];

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (plugin !== "全部" && item.plugin !== plugin) continue;

      if (query) {
        var haystack = [
          resolveName(item, lang),
          resolveName(item, lang === "zh" ? "en" : "zh"),
          item.matchName,
          item.displayName,
          item.plugin,
          resolveCategory(item, lang)
        ].join(" ").toLowerCase();
        if (haystack.indexOf(query) === -1) continue;
      }
      output.push(item);
    }
    return output;
  }

  return {
    isNoPreview: isNoPreview,
    isPoorPreviewTarget: isPoorPreviewTarget,
    excludeReason: excludeReason,
    isExcludable: isExcludable,
    isBuiltinEffect: isBuiltinEffect,
    previewRank: previewRank,
    interleaveByCategory: interleaveByCategory,
    inferPlugin: inferPlugin,
    resolveName: resolveName,
    resolveCategory: resolveCategory,
    spriteSlice: spriteSlice,
    categoryKey: categoryKey,
    categoryLabel: categoryLabel,
    categoryOrder: categoryOrder,
    categoryCounts: categoryCounts,
    sortItems: sortItems,
    choosePreview: choosePreview,
    buildItem: buildItem,
    filterItems: filterItems
  };
})();

if (typeof window !== "undefined") {
  window.AEV_ViewModel = AEV_ViewModel;
}
