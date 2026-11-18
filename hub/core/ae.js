/* ============================================================
 * ae.js —— 定位 After Effects、判断它是否在运行
 *
 * 多版本来源分三层，按可靠性从高到低：
 *   1. Adobe 自己的安装注册表
 *      HKLM\SOFTWARE\Adobe\After Effects\<版本>\InstallPath
 *      每个已安装版本各写各的，不会被后装的版本覆盖，
 *      自定义安装目录（D:/E:/G: 等非默认盘）也能拿到 —— 这是主依据；
 *   2. App Paths 注册项 —— 只有 AfterFX.exe 一个槽位，多版本时会被后装的覆盖，
 *      只当补充线索；
 *   3. 扫描各磁盘的常见 Program Files / Adobe 目录 —— 兜底。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const APP_PATH_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe",
  "HKCU\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe",
];
const ADOBE_AE_KEY = "HKLM\\SOFTWARE\\Adobe\\After Effects";
let registryCache = { at: 0, paths: [] };

function regQuery(args) {
  return execFileSync("reg.exe", args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** 展开 REG_EXPAND_SZ 风格的值（%ProgramFiles% 之类），REG_SZ 原样返回 */
function expandEnv(value) {
  return String(value).replace(/%([^%]+)%/g, (whole, name) => process.env[name] || whole);
}

/** App Paths 只有一个槽位：装多个 AE 时只留下最后安装的那个 */
function parseAppPaths(output) {
  const paths = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/\bREG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i);
    if (!match) continue;
    let candidate = match[1].trim().replace(/,\d+$/, "").replace(/^"|"$/g, "").trim();
    if (!/AfterFX\.exe$/i.test(candidate)) continue;
    paths.push(expandEnv(candidate));
  }
  return paths;
}

/** App Paths 只有一个槽位：装多个 AE 时只留下最后安装的那个 */
function appPathCandidates() {
  const paths = [];
  for (const key of APP_PATH_KEYS) {
    let output;
    try {
      output = regQuery(["query", key, "/ve"]);
    } catch {
      continue;
    }
    paths.push(...parseAppPaths(output));
  }
  return paths;
}

/**
 * HKLM\SOFTWARE\Adobe\After Effects\<版本>\InstallPath
 * 值是 Support Files 目录的绝对路径（可能带引号或末尾反斜杠）。
 * 已卸载但残留的项会在 findAfterFX 里被 existsSync 过滤掉。
 */
function parseInstallPaths(output) {
  const paths = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/InstallPath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i);
    if (!match) continue;
    const dir = expandEnv(match[1].replace(/^"|"$/g, "").replace(/[\\/]+$/, "")).trim();
    if (dir) paths.push(dir);
  }
  return paths;
}

function adobeInstallCandidates(query = regQuery) {
  let output;
  try {
    output = query(["query", ADOBE_AE_KEY, "/s", "/v", "InstallPath"]);
  } catch {
    return [];
  }
  return parseInstallPaths(output).map((dir) => path.join(dir, "AfterFX.exe"));
}

function registeredAfterFXPaths() {
  if (Date.now() - registryCache.at < 30000) return registryCache.paths;
  const paths = [...appPathCandidates(), ...adobeInstallCandidates()];
  registryCache = { at: Date.now(), paths: [...new Set(paths)] };
  return registryCache.paths;
}

function defaultRoots() {
  const roots = new Set(
    [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.ProgramW6432]
      .filter(Boolean),
  );
  for (let code = "C".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
    const drive = String.fromCharCode(code) + ":\\";
    if (!fs.existsSync(drive)) continue;
    roots.add(path.join(drive, "Program Files"));
    roots.add(path.join(drive, "Program Files (x86)"));
    roots.add(path.join(drive, "Adobe"));
  }
  return [...roots];
}

function addCandidate(found, exe) {
  if (!exe || !/AfterFX\.exe$/i.test(exe) || !fs.existsSync(exe)) return;
  const supportDir = path.dirname(exe);
  const installDir = path.dirname(supportDir);
  const name = path.basename(installDir) || "Adobe After Effects";
  const version = (name.match(/(\d{4})/) || (installDir.match(/(\d{4})/) || [, "0"]))[1];
  found.push({ name, exe, version });
}

/**
 * @param {{roots?: string[], registered?: string[]}} [options]
 * @returns {{name: string, exe: string, version: string}[]} 按版本升序
 */
function findAfterFX(options = {}) {
  const roots = Array.isArray(options.roots) ? options.roots : defaultRoots();
  const registered = Array.isArray(options.registered)
    ? options.registered
    : registeredAfterFXPaths();
  const found = [];

  for (const exe of registered) addCandidate(found, exe);

  for (const root of roots) {
    const adobe = path.join(root, "Adobe");
    let entries;
    try {
      entries = fs.readdirSync(adobe, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^Adobe After Effects/i.test(entry.name)) continue;
      const exe = path.join(adobe, entry.name, "Support Files", "AfterFX.exe");
      addCandidate(found, exe);
    }
  }

  const unique = new Map();
  for (const item of found) unique.set(item.exe.toLowerCase(), item);
  return [...unique.values()].sort(
    (a, b) => Number(a.version) - Number(b.version) || a.name.localeCompare(b.name),
  );
}

/** 最新可用的 AfterFX.exe 绝对路径，找不到返回 "" */
function bestAfterFX() {
  const all = findAfterFX();
  return all.length ? all[all.length - 1].exe : "";
}

/**
 * AE 是否正在运行。
 * 渲染要求「用户先关闭 AE」，Hub 靠它决定按钮是提示还是直接开跑。
 */
function isAERunning() {
  try {
    const out = execFileSync(
      "tasklist",
      ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"],
      { encoding: "utf8", windowsHide: true, timeout: 5000 },
    );
    return /AfterFX\.exe/i.test(out);
  } catch {
    return false;
  }
}

module.exports = {
  findAfterFX,
  bestAfterFX,
  isAERunning,
  __internals: { parseInstallPaths, adobeInstallCandidates, parseAppPaths, appPathCandidates },
};
