const test = require("node:test");
const assert = require("node:assert/strict");
const previewNames = require("../core/preview_names");

test("预览目录名：中文转拼音、英文保持 slug、同名稳定去重", () => {
  assert.equal(previewNames.asciiSlug("360 度循环"), "360-du-xun-huan");
  assert.equal(
    previewNames.asciiSlug("3D 按随机顺序振动进入"),
    "3d-an-sui-ji-shun-xu-zhen-dong-jin-ru",
  );
  assert.equal(previewNames.effectFolder("内置"), "builtin");
  assert.equal(previewNames.effectFolder("其它插件"), "other");
  assert.equal(previewNames.effectFolder("BCC"), "bcc");
  const rows = [
    { name: "同名", path: "C:/a.ffx" },
    { name: "同名", path: "C:/b.ffx" },
  ];
  previewNames.assignPresetFolders(rows);
  assert.notEqual(rows[0].folder, rows[1].folder);
  assert.match(rows[0].folder, /^tong-ming-[0-9a-f]{8}$/);
  assert.match(rows[1].folder, /^tong-ming-[0-9a-f]{8}$/);
});
