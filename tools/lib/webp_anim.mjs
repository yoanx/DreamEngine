/* ============================================================
 * tools/lib/webp_anim.mjs —— ESM 薄封装，容器实现只有一份
 *
 * 封装逻辑住在 hub/core/webp_anim.js（Hub 是 CommonJS），
 * 这里只做「读文件 → 调它 → 写文件」的适配，避免两边各抄一份容器代码。
 * ============================================================ */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import sharp from "../../hub/node_modules/sharp/lib/index.js";

const require = createRequire(import.meta.url);
const { mergeWebpBuffers } = require("../../hub/core/webp_anim.js");

/**
 * @param {string[]} frameFiles 按顺序排列的单帧 WebP 路径
 * @param {{ fps?: number, outFile: string, loop?: number }} options
 */
export async function mergeFramesToAnimatedWebp(frameFiles, options) {
  const fps = Number(options.fps) || 24;
  const first = await sharp(frameFiles[0]).metadata();
  const buffers = frameFiles.map((file) => readFileSync(file));
  const data = mergeWebpBuffers(buffers, {
    width: Number(first.width),
    height: Number(first.height),
    delayMs: 1000 / fps,
    loop: Number.isFinite(options.loop) ? options.loop : 0,
  });
  writeFileSync(options.outFile, data);
  return {
    pages: buffers.length,
    bytes: statSync(options.outFile).size,
    width: Number(first.width),
    height: Number(first.height),
  };
}

/** 按 %04d 模板枚举出实际存在的帧文件 */
export function existingFrames(template, count, resolveFile) {
  const files = [];
  for (let i = 0; i < count; i++) {
    const rel = String(template).replace("%04d", String(i).padStart(4, "0"));
    const abs = resolveFile(rel);
    if (!abs) break;
    files.push(abs);
  }
  return files;
}
