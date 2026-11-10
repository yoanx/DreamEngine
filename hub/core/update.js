/* ============================================================
 * update.js —— GitHub Releases 更新检查
 *
 * 主进程负责网络请求，渲染进程只接收检查结果并打开下载页。
 * ============================================================ */

const https = require("node:https");

const REPO = "yoanx/DreamEngine";
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=20`;

function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function parseVersion(value) {
  const text = normalizeVersion(value);
  const dash = text.indexOf("-");
  const core = (dash >= 0 ? text.slice(0, dash) : text)
    .split(".")
    .map((part) => Number(part) || 0);
  const prerelease = dash >= 0
    ? text.slice(dash + 1).split(".").filter(Boolean)
    : [];
  return { core, prerelease };
}

function compareIdentifiers(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an !== bn) return an ? -1 : 1;
  return a.localeCompare(b);
}

/** 比较 semver-like 版本；返回负数、0 或正数。 */
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.core.length, b.core.length);
  for (let i = 0; i < length; i++) {
    const delta = (a.core[i] || 0) - (b.core[i] || 0);
    if (delta) return delta;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const prereleaseLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < prereleaseLength; i++) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const delta = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (delta) return delta;
  }
  return 0;
}

function pickLatestRelease(releases) {
  return (Array.isArray(releases) ? releases : [])
    .filter((release) => release && release.tag_name)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] || null;
}

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "DreamEngine-Hub",
        },
      },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          requestJson(response.headers.location).then(resolve, reject);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`GitHub HTTP ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error("GitHub 返回了无效 JSON"));
          }
        });
      },
    );
    request.setTimeout(8000, () => request.destroy(new Error("检查更新超时")));
    request.on("error", reject);
  });
}

async function checkForUpdates(options = {}) {
  const currentVersion = normalizeVersion(options.currentVersion || "0.0.0");
  const fetchReleases = options.fetchReleases || (() => requestJson(RELEASES_API));
  try {
    const releases = await fetchReleases();
    const latest = pickLatestRelease(releases);
    if (!latest) return { ok: false, reason: "no_releases" };
    const latestTag = normalizeVersion(latest.tag_name);
    return {
      ok: true,
      currentVersion,
      latestVersion: latestTag,
      latestTag: String(latest.tag_name || ""),
      updateAvailable: compareVersions(latestTag, currentVersion) > 0,
      releaseUrl: latest.html_url || `${RELEASES_URL}/tag/${encodeURIComponent(latest.tag_name)}`,
      name: String(latest.name || latestTag),
      publishedAt: String(latest.published_at || ""),
    };
  } catch (error) {
    return { ok: false, reason: String(error && error.message ? error.message : error) };
  }
}

module.exports = {
  RELEASES_URL,
  RELEASES_API,
  normalizeVersion,
  compareVersions,
  pickLatestRelease,
  checkForUpdates,
};
