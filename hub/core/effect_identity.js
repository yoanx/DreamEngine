/* Stable preview identity for third-party effects.
 *
 * Plugin updates may change matchName without changing the user-visible effect.
 * Preview validity therefore follows plugin + displayName, while matchName stays
 * a runtime handle used to invoke the current AE build.
 */

function normalizePart(value) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function previewKey(plugin, displayName) {
  const pluginPart = normalizePart(plugin);
  const namePart = normalizePart(displayName);
  return pluginPart && namePart ? pluginPart + "::" + namePart : "";
}

function normalizePreviewKey(value) {
  return String(value || "").trim().toLowerCase();
}

module.exports = { previewKey, normalizePreviewKey };
