const crypto = require("node:crypto");
const { pinyin } = require("pinyin-pro");

const PLUGIN_ALIASES = {
  "内置": "builtin",
  "其它插件": "other",
  "BCC": "bcc",
  "Sapphire": "sapphire",
  "Red Giant": "red-giant",
  "RE:Vision": "revision",
  "Video Copilot": "video-copilot",
};

function asciiSlug(value, fallback = "item") {
  let text = String(value || "").trim();
  try {
    text = pinyin(text, {
      toneType: "none",
      type: "array",
      nonZh: "consecutive",
    }).join(" ");
  } catch {
    /* pinyin-pro 失败时仍保留英文/数字 */
  }
  text = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 96)
    .replace(/[. ]+$/g, "");
  if (!text) text = String(fallback || "item");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(text)) text = "_" + text;
  return text || "item";
}

function effectFolder(value) {
  const raw = String(value || "").trim();
  return asciiSlug(PLUGIN_ALIASES[raw] || raw, "other");
}

function pathSuffix(value) {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex").slice(0, 8);
}

function assignPresetFolders(items) {
  const rows = Array.isArray(items) ? items : [];
  const groups = new Map();
  for (const item of rows) {
    if (!item) continue;
    const base = asciiSlug(item.name || item.fileName || "preset", "preset");
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(item);
  }
  for (const [base, group] of groups) {
    for (const item of group) {
      item.folder = group.length === 1 ? base : `${base}-${pathSuffix(item.path || item.name)}`;
    }
  }
  return rows;
}

function presetFolder(name, presetPath) {
  return asciiSlug(name || "preset", "preset") + "-" + pathSuffix(presetPath || name);
}

module.exports = {
  asciiSlug,
  effectFolder,
  assignPresetFolders,
  presetFolder,
};
