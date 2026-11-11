const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const codec = require("../core/preview_codec");

async function frame(color) {
  return sharp({
    create: {
      width: 720,
      height: 720,
      channels: 4,
      background: color,
    },
  })
    .png()
    .toBuffer();
}

test("preview_codec 把 24 张 720×720 帧编码成 24fps 动画 WebP", async () => {
  const frames = [];
  for (let index = 0; index < 24; index++) {
    frames.push(await frame({ r: index * 7, g: 80, b: 140, alpha: 1 }));
  }

  const encoded = await codec.encodeAnimatedWebp(frames, {
    width: 720,
    height: 720,
    fps: 24,
    quality: 78,
  });

  assert.equal(encoded.toString("ascii", 0, 4), "RIFF");
  assert.equal(encoded.toString("ascii", 8, 12), "WEBP");

  const metadata = await sharp(encoded, { animated: true }).metadata();
  assert.equal(metadata.width, 720);
  assert.equal(metadata.pageHeight, 720);
  assert.ok(metadata.pages <= 24);
  assert.equal(metadata.delay.reduce((sum, value) => sum + value, 0), 1008);
});
