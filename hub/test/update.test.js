const test = require("node:test");
const assert = require("node:assert/strict");
const {
  compareVersions,
  pickLatestRelease,
  checkForUpdates,
} = require("../core/update");

test("版本比较支持 prerelease 和数字段", () => {
  assert.ok(compareVersions("0.2.0-beta.7", "0.2.0-beta.6") > 0);
  assert.ok(compareVersions("0.2.0-beta.10", "0.2.0-beta.9") > 0);
  assert.ok(compareVersions("0.2.0", "0.2.0-beta.6") > 0);
  assert.equal(compareVersions("v0.2.0-beta.6", "0.2.0-beta.6"), 0);
});

test("从 GitHub Releases 中选出最高版本", () => {
  const latest = pickLatestRelease([
    { tag_name: "v0.2.0-beta.6" },
    { tag_name: "v0.2.0-beta.8" },
    { tag_name: "v0.2.0-beta.7" },
  ]);
  assert.equal(latest.tag_name, "v0.2.0-beta.8");
});

test("更新检查返回可打开的 GitHub Release", async () => {
  const result = await checkForUpdates({
    currentVersion: "0.2.0-beta.6",
    fetchReleases: async () => [{
      tag_name: "v0.2.0-beta.7",
      name: "beta.7",
      html_url: "https://github.com/yoanx/DreamEngine/releases/tag/v0.2.0-beta.7",
    }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.updateAvailable, true);
  assert.equal(result.latestVersion, "0.2.0-beta.7");
  assert.match(result.releaseUrl, /releases\/tag\/v0\.2\.0-beta\.7$/);
});

test("当前已是最新版本时不提示更新", async () => {
  const result = await checkForUpdates({
    currentVersion: "0.2.0-beta.7",
    fetchReleases: async () => [{ tag_name: "v0.2.0-beta.7" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.updateAvailable, false);
});
