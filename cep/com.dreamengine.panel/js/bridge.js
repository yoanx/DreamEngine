/* ============================================================
 * bridge.js —— CEP ↔ AE(ExtendScript) 最小通道
 *
 * 分层约定（见设计文档 §2）：所有 AE 数据读写只走 evalAE 执行 .jsx 字符串，
 * 面板侧不出现任何 AE 对象引用。本文件是全项目唯一允许直接触碰
 * window.__adobe_cep__ 的地方。
 *
 * 语法：只用 ES5，避免依赖 CEF 的新特性。
 * ============================================================ */

var Bridge = (function () {

  function isCEP() {
    return !!(window.__adobe_cep__ && window.__adobe_cep__.evalScript);
  }

  /** 在 AE 的 ExtendScript 引擎里执行一段脚本字符串。
   *  @param {string} jsx  必须是自包含的 IIFE 或表达式，返回值会被转成字符串
   *  @param {function(string)} cb
   */
  function evalAE(jsx, cb) {
    if (!isCEP()) {
      if (cb) cb("__NOT_CEP__");
      return;
    }
    window.__adobe_cep__.evalScript(jsx, function (res) {
      if (cb) cb(res === undefined || res === null ? "" : String(res));
    });
  }

  /** 让 AE 侧把一个安全值取回来（自动包 IIFE + String()） */
  function evalAERaw(expr, cb) {
    evalAE("(function(){try{return String(" + expr + ")}catch(e){return 'ERR:'+e.toString()}})()", cb);
  }

  /** 通过 AE 写文本文件（复用探针的输出目录约定） */
  function writeFile(absPath, text, cb) {
    var jsx =
      "(function(){" +
      "  try{" +
      "    var f = new File(" + JSON.stringify(absPath) + ");" +
      "    if(!f.open('w')) return 'OPEN_FAIL:' + f.fsName;" +
      "    f.write(" + JSON.stringify(text) + ");" +
      "    f.close();" +
      "    return 'OK:' + f.fsName;" +
      "  }catch(e){return 'ERR:'+e.toString();}" +
      "})()";
    evalAE(jsx, cb);
  }

  /** 让 AE 列目录下的文件名（面板没有本地目录读取能力） */
  function listFiles(dirPath, pattern, cb) {
    var jsx =
      "(function(){" +
      "  try{" +
      "    var d = new Folder(" + JSON.stringify(dirPath) + ");" +
      "    if(!d.exists) return 'NO_DIR';" +
      "    var fs = d.getFiles(" + JSON.stringify(pattern) + ");" +
      "    var out = [];" +
      "    for(var i=0;i<fs.length;i++){" +
      "      if(fs[i] instanceof File) out.push(fs[i].name + '\\t' + fs[i].length);" +
      "    }" +
      "    return 'OK\\t' + out.join('\\n');" +
      "  }catch(e){return 'ERR:'+e.toString();}" +
      "})()";
    evalAE(jsx, cb);
  }

  /** 取「我的文档」绝对路径（交给 AE 判断，最可靠） */
  function getDocsPath(cb) {
    evalAE("(function(){try{return Folder.myDocuments.fsName}catch(e){return ''}})()", function (p) {
      if (!p || p.indexOf("ERR") === 0) { cb(""); return; }
      // 统一成正斜杠，便于拼 file:// URL
      cb(String(p).replace(/\\/g, "/"));
    });
  }

  /** 当前扩展根目录，用于让 AE 执行 engine/*.jsx。 */
  function getExtensionPath(cb) {
    try {
      var path = window.__adobe_cep__.getSystemPath("extension");
      cb(String(path).replace(/\\/g, "/"));
    } catch (e) {
      cb("");
    }
  }

  /** engine 目录下的模块，按依赖顺序加载。
   *  curve_math 必须最先（纯数学，浏览器也加载同一个文件）；
   *  render_config 次之（previewgen 读它的定版参数）；
   *  store 与 recipe 在 previewgen 之前（previewgen 依赖两者）。
   */
  var ENGINE_FILES = [
    "engine/curve_math.js",
    "engine/curve_graph.js",
    "engine/render_config.jsx",
    "engine/store.jsx",
    "engine/preset_categories.jsx",
    "engine/materials.jsx",
    "engine/names.jsx",
    "engine/curvelib.jsx",
    "engine/assets.jsx",
    "engine/recipe.jsx",
    "engine/apply.jsx",
    "engine/previewgen.jsx",
    "engine/plugin_state.jsx",
    "engine/catalog.jsx",
    "engine/presets.jsx"
  ];

  /** 加载 engine 全部模块并求值一个表达式。
   *  @param {string} extensionPath  扩展根目录（正斜杠）
   *  @param {string} expr   ES3 表达式，例如 AEV_PreviewGen.staleList(...)
   *  @param {function(string)} cb
   */
  function runEngine(extensionPath, expr, cb) {
    if (!isCEP()) {
      if (cb) cb("__NOT_CEP__");
      return;
    }
    if (!extensionPath) {
      if (cb) cb("ERR:no_extension_path");
      return;
    }

    var paths = [];
    for (var i = 0; i < ENGINE_FILES.length; i++) {
      paths.push(JSON.stringify(extensionPath + "/" + ENGINE_FILES[i]));
    }

    var jsx =
      "(function(){" +
      "  try{" +
      "    var files = [" + paths.join(",") + "];" +
      // 用文件修改时间做戳：戳没变就跳过 evalFile —— 每次调用都重载九个
      // 模块是面板刷新发顿的主因（一次刷新要调好几次 runEngine）。
      // 戳变了说明引擎代码改过，自动重载，开发期不用手动清缓存。
      "    var stamp = '';" +
      "    for(var i=0;i<files.length;i++){" +
      "      var f = new File(files[i]);" +
      "      if(!f.exists) return 'ERR:missing_engine:' + files[i];" +
      "      try { stamp += f.modified.getTime() + ':'; } catch(e1) { stamp += 'x:'; }" +
      "    }" +
      // 戳之外还要校验「模块真的在」。原因：AE 会话里 AEV_EngineStamp 是全局的，
      // 一旦某次 evalFile 中途失败（比如某个模块语法错），戳已经被写进去，
      // 之后无论文件怎么改都会跳过加载 —— 表现就是
      // 「ERR:ReferenceError: AEV_Catalog 未定义」，整个效果库空白。
      // 所以这里额外检查几个关键模块是否存在，缺了就强制重载。
      "    var missing = '';" +
      "    if (typeof AEV_Catalog === 'undefined') missing = 'AEV_Catalog';" +
      "    else if (typeof AEV_Materials === 'undefined') missing = 'AEV_Materials';" +
      "    else if (typeof AEV_Recipe === 'undefined') missing = 'AEV_Recipe';" +
      "    else if (typeof AEV_Apply === 'undefined') missing = 'AEV_Apply';" +
      "    else if (typeof AEV_Presets === 'undefined') missing = 'AEV_Presets';" +
      "    else if (typeof AEV_Curve === 'undefined') missing = 'AEV_Curve';" +
      "    else if (typeof AEV_CurveGraph === 'undefined') missing = 'AEV_CurveGraph';" +
      "    if (typeof AEV_EngineStamp === 'undefined') AEV_EngineStamp = '';" +
      "    if (stamp !== AEV_EngineStamp || missing !== '') {" +
      // 逐个 evalFile 并各自捕获：某一个模块加载失败时，
      // 其余模块仍能加载（catalog 挂了不影响 recipe），
      // 而且失败原因会明确报出来，而不是被后面的模块覆盖成
      // 「AEV_Catalog 未定义」这种误导性的报错。
      "      var loadErr = '';" +
      "      for(var j=0;j<files.length;j++){" +
      "        try { $.evalFile(new File(files[j])); }" +
      // 只保留**第一个**失败原因：它就是真正的元凶，后面的失败往往是它连带出来的。
      // 旧写法里有个「不含 catalog 就清空」的过滤，把 curvelib 的语法错误吞掉，
      // 面板上只剩「AEV_Curve 未定义」这种误导性提示（实机踩过）。
      "        catch(ej) { if (loadErr === '') loadErr = files[j] + ':' + ej.toString(); }" +
      "      }" +
      "      AEV_EngineStamp = stamp;" +
      "      if (loadErr !== '') return 'ERR:engine_load:' + loadErr;" +
      "    }" +
      "    return String(" + expr + ");" +
      "  }catch(e){return 'ERR:'+e.toString();}" +
      "})()";
    evalAE(jsx, cb);
  }

  /** 打开目录（在资源管理器/Finder 里显示探针输出） */
  function revealDir(dirPath, cb) {
    var jsx = "(function(){try{return String(new Folder(" +
              JSON.stringify(dirPath) + ").execute())}catch(e){return 'ERR:'+e}})()";
    evalAE(jsx, cb);
  }

  /**
   * 启动 DreamEngine Hub。
   *
   * Hub 与面板安装在不同的位置，而且安装目录允许用户修改。优先读取 Hub
   * 首次运行时写入的 hub-path.txt；没有标记时再查开始菜单和常见安装目录。
   * 同一路径重复启动会由 Hub 的单实例锁聚焦已有窗口。
   */
  function openHub(cb) {
    getExtensionPath(function (extensionPath) {
      var jsx =
        "(function(){" +
        "  try{" +
        "    var ext = " + JSON.stringify(extensionPath || "") + ";" +
      "    var candidates = [];" +
      "    function add(path) { if (path) candidates.push(String(path)); }" +
      "    var docs = Folder.myDocuments.fsName;" +
      "    var marker = new File(docs + '/DreamEngine/hub-path.txt');" +
      "    if (marker.exists && marker.open('r')) {" +
      "      var marked = marker.read();" +
      "      marker.close();" +
      "      marked = marked.replace(/^\\uFEFF/, '').replace(/[\\r\\n]+/g, '');" +
      "      if (marked.toLowerCase().indexOf('dreamengine hub.exe') >= 0) add(marked);" +
      "    }" +
      "    var appData = '';" +
      "    try { appData = Folder.userData.fsName; } catch (e0) {}" +
      "    var local = $.getenv('LOCALAPPDATA') || '';" +
      "    var pf = $.getenv('ProgramFiles') || '';" +
      "    var pfx = $.getenv('ProgramFiles(x86)') || '';" +
      "    add(appData + '/Microsoft/Windows/Start Menu/Programs/DreamEngine Hub.lnk');" +
      "    add(appData + '/Microsoft/Windows/Start Menu/Programs/DreamEngine/DreamEngine Hub.lnk');" +
      "    add(Folder.desktop.fsName + '/DreamEngine Hub.lnk');" +
      "    var roots = [local + '/Programs', local, pf, pfx];" +
      "    for (var i = 0; i < roots.length; i++) {" +
      "      if (!roots[i]) continue;" +
      "      add(roots[i] + '/DreamEngine Hub/DreamEngine Hub.exe');" +
      "      add(roots[i] + '/dreamengine-hub/DreamEngine Hub.exe');" +
      "    }" +
      "    if (ext) add(ext + '/../../hub/dist/win-unpacked/DreamEngine Hub.exe');" +
      // electron-builder 的目录名可能随版本变化；只扫 Programs 下一层，
      // 避免遍历整个 Program Files。
      "    try {" +
      "      var programs = new Folder(local + '/Programs');" +
      "      var entries = programs.getFiles();" +
      "      for (var j = 0; j < entries.length; j++) {" +
      "        if (entries[j] instanceof Folder) {" +
      "          add(entries[j].fsName + '/DreamEngine Hub.exe');" +
      "        }" +
      "      }" +
      "    } catch (e1) {}" +
      "    for (var k = 0; k < candidates.length; k++) {" +
      "      try {" +
      "        var file = new File(candidates[k]);" +
      "        if (file.exists && file.execute()) return 'OK:' + file.fsName;" +
      "      } catch (e2) {}" +
      "    }" +
      "    return 'NOT_FOUND';" +
      "  } catch (e) { return 'ERR:' + e.toString(); }" +
      "})()";
      evalAE(jsx, cb);
    });
  }

  /** 自检：AE 版本 + 写权限 */
  function selfCheck(cb) {
    var out = { cep: isCEP(), aeVersion: "", writePref: "unknown", docs: "" };
    if (!isCEP()) { cb(out); return; }
    evalAERaw("app.version", function (v) {
      out.aeVersion = v;
      // AE 里没有 app.settings —— 旧代码那一行恒抛错、被 try/catch 吞掉，
      // 自检结果永远是 'no_api'，等于没检查。正确入口是 app.preferences。
      evalAERaw(
        'app.preferences && app.preferences.getPrefAsLong ? ' +
        'app.preferences.getPrefAsLong("Main Pref Section", "Pref_SCRIPTING_FILE_NETWORK_SECURITY", -1) ' +
        ': "no_api"',
        function (w) {
          out.writePref = w;
          getDocsPath(function (d) { out.docs = d; cb(out); });
        });
    });
  }

  return {
    isCEP: isCEP,
    evalAE: evalAE,
    evalAERaw: evalAERaw,
    writeFile: writeFile,
    listFiles: listFiles,
    getDocsPath: getDocsPath,
    getExtensionPath: getExtensionPath,
    runEngine: runEngine,
    ENGINE_FILES: ENGINE_FILES,
    revealDir: revealDir,
    openHub: openHub,
    selfCheck: selfCheck
  };
})();
