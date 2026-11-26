/* ============================================================
 * ui_prefs.js —— 面板界面偏好（Hub 写，AE 面板读）
 *
 * 面板自己没有设置页：语言这类跨端一致的偏好在 Hub 里改，
 * 写到 <文档>/DreamEngine/ui_prefs.json，面板启动时读一次。
 * ============================================================ */

const fs = require("node:fs");
const path = require("node:path");

const LANGS = ["zh", "en"];

function emptyDoc() {
  return { version: 1, panelLang: "zh" };
}

function read(paths) {
  let raw;
  try {
    raw = fs.readFileSync(paths.uiPrefs, "utf8");
  } catch {
    return emptyDoc();
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return emptyDoc();
  }
  const lang = String((doc && doc.panelLang) || "");
  return {
    version: 1,
    panelLang: LANGS.includes(lang) ? lang : "zh",
  };
}

function write(paths, doc) {
  fs.mkdirSync(path.dirname(paths.uiPrefs), { recursive: true });
  fs.writeFileSync(paths.uiPrefs, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return doc;
}

function setPanelLang(paths, lang) {
  const value = String(lang || "");
  if (!LANGS.includes(value)) return { ok: false, reason: "invalid_lang", doc: read(paths) };
  const doc = read(paths);
  doc.panelLang = value;
  write(paths, doc);
  return { ok: true, doc };
}

module.exports = { LANGS, read, write, setPanelLang };
