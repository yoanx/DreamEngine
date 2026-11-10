#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DOCS = join(process.env.USERPROFILE || "", "Documents");
const PROBE = join(DOCS, "DreamEngineProbe");
const FIXTURE = join(PROBE, "materials_e2e_fixture");
const REPORT = join(PROBE, "materials_e2e.json");
const INDEX_DIR = join(DOCS, "DreamEngine", "materials");
const INDEX_FILES = ["index.tsv", "index.json"];
const AE = "C:/Program Files/Adobe/Adobe After Effects 2021/Support Files/AfterFX.exe";
const SCRIPT = resolve(ROOT, "tools/run_materials_e2e.jsx");

function findFfmpeg() {
  try {
    return execFileSync("where.exe", ["ffmpeg"], { encoding: "utf8" })
      .split(/\r?\n/)[0]
      .trim();
  } catch {
    return "";
  }
}

function aeRunning() {
  try {
    return execFileSync("tasklist", ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"], {
      encoding: "utf8",
    }).indexOf("AfterFX.exe") >= 0;
  } catch {
    return false;
  }
}

function prepareFixture(ffmpeg) {
  rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(FIXTURE, { recursive: true });
  const imageSource = readdirSync(resolve(ROOT, "dist/L1/thumbs"))
    .find((name) => /\.png$/i.test(name));
  if (!imageSource) throw new Error("No PNG fixture available in dist/L1/thumbs");
  copyFileSync(resolve(ROOT, "dist/L1/thumbs", imageSource), join(FIXTURE, "image.png"));

  const aep = join(PROBE, "save_api_initial.aep");
  if (!existsSync(aep)) throw new Error("No .aep fixture available");
  copyFileSync(aep, join(FIXTURE, "project.aep"));
  writeFileSync(join(FIXTURE, "notes.txt"), "ignored", "utf8");

  for (const args of [
    ["-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-t", "1", "-pix_fmt", "yuv420p", join(FIXTURE, "video.mp4")],
    ["-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10", "-t", "1", "-c:v", "mpeg4", "-q:v", "5", join(FIXTURE, "unsupported.avi")],
    ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", join(FIXTURE, "audio.wav")],
  ]) {
    execFileSync(ffmpeg, args, { stdio: "pipe" });
  }
}

async function waitForReport(timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (existsSync(REPORT)) {
      try {
        return JSON.parse(readFileSync(REPORT, "utf8"));
      } catch {
        // AE 可能刚创建文件、还没写完；下一轮再读。
      }
    }
    if (!aeRunning()) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
      if (existsSync(REPORT)) {
        try {
          return JSON.parse(readFileSync(REPORT, "utf8"));
        } catch {}
      }
      throw new Error("AE exited before writing materials_e2e.json");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error("Timed out waiting for materials_e2e.json");
}

async function waitForAeExit(timeoutMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!aeRunning()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  if (aeRunning()) {
    execFileSync("taskkill", ["/IM", "AfterFX.exe", "/T", "/F"], {
      stdio: "ignore",
    });
  }
}

if (!existsSync(AE)) throw new Error("AE 2021 not found");
if (aeRunning()) throw new Error("Close After Effects before running the materials E2E test");
const ffmpeg = findFfmpeg();
if (!ffmpeg) throw new Error("ffmpeg not found");

mkdirSync(PROBE, { recursive: true });
mkdirSync(INDEX_DIR, { recursive: true });
const backups = new Map();
for (const name of INDEX_FILES) {
  const path = join(INDEX_DIR, name);
  backups.set(path, existsSync(path) ? readFileSync(path) : null);
}
if (existsSync(REPORT)) rmSync(REPORT, { force: true });

try {
  prepareFixture(ffmpeg);
  const child = spawn(AE, ["-r", SCRIPT], { detached: true, stdio: "ignore" });
  child.unref();
  const result = await waitForReport();
  assert.equal(result.status, "ok", result.reason || "materials E2E failed");
  assert.equal(result.counts.video, 2);
  assert.equal(result.counts.image, 1);
  assert.equal(result.counts.audio, 1);
  assert.equal(result.counts.project, 1);
  assert.equal(result.txtIgnored, true);
  assert.equal(result.videoPreview, true);
  assert.equal(result.audioWaveformInIndex, false, "音频波形应在 CEP 面板内生成，AE 扫描不应写入波形文件");
  assert.equal(result.imported, true);
  assert.equal(result.addedToComp, true);
  assert.ok(Math.abs(result.layerStartTime - result.targetTime) < 0.001,
    "素材没有落在当前时间指示器：" + result.layerStartTime + " / " + result.targetTime);
  assert.equal(result.projectImported, true);
  console.log("[PASS] AE materials E2E scan/preview/import");
} finally {
  for (const [path, content] of backups) {
    if (content == null) rmSync(path, { force: true });
    else writeFileSync(path, content);
  }
  rmSync(FIXTURE, { recursive: true, force: true });
  await waitForAeExit();
}
