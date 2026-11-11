const sharp = require("sharp");

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError("preview frame must be a Buffer or Uint8Array");
}

async function encodeAnimatedWebp(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("preview frames are empty");
  }

  const fps = Math.max(1, Number(options.fps) || 24);
  const delay = Math.max(1, Math.round(1000 / fps));
  const quality = Math.max(1, Math.min(100, Number(options.quality) || 80));
  const input = frames.map(asBuffer);

  return sharp(input, { join: { animated: true } })
    .webp({
      quality,
      effort: 4,
      loop: 0,
      delay: input.map(() => delay),
    })
    .toBuffer();
}

module.exports = { encodeAnimatedWebp };
