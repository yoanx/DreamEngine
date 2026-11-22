/* ============================================================
 * webp_anim.js —— 把一串单帧 WebP 封装成一个动画 WebP
 *
 * 为什么自己拼容器：sharp 的 WebP 编码器不产出动画（只写 VP8X，
 * 没有 ANIM/ANMF，最终落第 0 帧）。容器格式本身很简单，手写比引依赖划算。
 *
 * 单帧是各自独立的有损 VP8 / 无损 VP8L，这里直接复用原始码流塞进 ANMF，
 * 不重新编码 —— 画质与体积都不会二次劣化。
 *
 * 三处共用（Hub 生成、发布打包、离线工具）：唯一实现放在这里，
 * 不要在别处再抄一份，否则容器字段一旦写错会有多份不同行为。
 * ============================================================ */

const u24 = (v) => Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff]);

function chunk(tag, payload) {
  const pad = payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
  const head = Buffer.alloc(8);
  head.write(tag, 0, "latin1");
  head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, pad]);
}

/** 取出单帧 WebP 的图像码流（VP8 / VP8L）与可选 ALPH */
function imageChunks(buf) {
  let at = 12;
  let vp = null;
  let alph = null;
  while (at + 8 <= buf.length) {
    const tag = buf.toString("latin1", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const payload = buf.subarray(at + 8, at + 8 + size);
    if (tag === "ALPH") alph = payload;
    if (tag === "VP8 " || tag === "VP8L") {
      vp = { tag, payload };
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!vp) throw new Error("找不到图像码流（既非 VP8 也非 VP8L）");
  return { vp, alph };
}

/**
 * @param {Buffer[]} buffers 按顺序排列的单帧 WebP
 * @param {{width:number, height:number, delayMs?:number, loop?:number}} options
 * @returns {Buffer} 完整的 RIFF/WEBP 文件内容
 */
function mergeWebpBuffers(buffers, options) {
  if (!Array.isArray(buffers) || !buffers.length) throw new Error("没有可合并的帧");
  const width = Number(options && options.width) || 0;
  const height = Number(options && options.height) || 0;
  if (!width || !height) throw new Error("合并动画 WebP 需要显式 width/height");
  const delayMs = Math.max(10, Math.round(Number(options && options.delayMs) || 42));
  const loop = Number.isFinite(options && options.loop) ? options.loop : 0;

  const anmfs = buffers.map((buf) => {
    const { vp, alph } = imageChunks(buf);
    const inner = alph
      ? [chunk("ALPH", alph), chunk(vp.tag, vp.payload)]
      : [chunk(vp.tag, vp.payload)];
    return chunk("ANMF", Buffer.concat([
      u24(0), u24(0), u24(width - 1), u24(height - 1), u24(delayMs),
      Buffer.from([0x02]),
      ...inner,
    ]));
  });

  const vp8x = chunk("VP8X", Buffer.concat([
    Buffer.from([0x02, 0, 0, 0]),
    u24(width - 1), u24(height - 1),
  ]));
  const anim = chunk("ANIM", Buffer.concat([
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([loop & 0xff, (loop >> 8) & 0xff]),
  ]));

  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), vp8x, anim, ...anmfs]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

module.exports = { mergeWebpBuffers, imageChunks };
