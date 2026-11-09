const test = require("node:test");
const assert = require("node:assert/strict");

const { parseDump, safeName } = require("../core/manual_effect");

function dump(rows) {
  return [
    "indexPath\tpath\tname\ttype\tvalue\tcanAnimate\thasMin\tmin\thasMax\tmax\taux\tsafe\treason",
    ...rows,
  ].join("\r\n");
}

test("parseDump: OneD / Checkbox / Color 与 indexPath 解析", () => {
  const params = parseDump(dump([
    "1\t颜色 / 强度\t强度\tOneD\t100\t1\t1\t0\t1\t300\t0\t1\t",
    "2\t启用\t启用\tCheckbox\ttrue\t0\t0\t0\t0\t0\t0\t0\t",
    "3\t颜色\t颜色\tColor\t[1,0,0,1]\t0\t0\t0\t0\t0\t0\t0\t",
  ]));
  assert.equal(params.length, 3);
  assert.deepEqual(
    params.map((item) => [item.indexPath, item.name, item.type, item.value, item.valueType]),
    [
      ["1", "强度", "OneD", 100, "number"],
      ["2", "启用", "Checkbox", true, "boolean"],
      ["3", "颜色", "Color", [1, 0, 0, 1], "array"],
    ],
  );
  assert.equal(params[0].hasMin, true);
  assert.equal(params[0].max, 300);
});

test("parseDump: 缺 indexPath 的行跳过", () => {
  const params = parseDump(dump([
    "\t空\t空\tOneD\t1\t0\t0\t0\t0\t0\t0\t0\t",
    "1\t有效\t有效\tOneD\t1\t0\t0\t0\t0\t0\t0\t1\t",
  ]));
  assert.equal(params.length, 1);
  assert.equal(params[0].indexPath, "1");
});

test("safeName: 去掉 Windows 非法字符并限长", () => {
  assert.equal(safeName("BCC+ 方向/模糊"), "BCC+_方向_模糊");
  assert.equal(safeName(""), "effect");
  assert.ok(safeName("x".repeat(200)).length <= 80);
});
