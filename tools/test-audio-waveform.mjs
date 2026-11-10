#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = resolve(ROOT, "cep/com.dreamengine.panel/js/audio_waveform.js");
const context = vm.createContext({ window: {}, console });
vm.runInContext(readFileSync(SOURCE, "utf8"), context, { filename: "audio_waveform.js" });
const W = context.AEV_AudioWaveform;
assert.ok(W, "AEV_AudioWaveform was not exported");

const samples = new Float32Array([0, 1, 0, -1, 0.5, 0.5, -0.5, -0.5]);
const buffer = {
  numberOfChannels: 1,
  length: samples.length,
  getChannelData() { return samples; }
};
const peaks = Array.from(W.peaksFromBuffer(buffer, 4));
assert.deepEqual(peaks, [1, 1, 0.5, 0.5]);

const calls = [];
const canvas = {
  width: 320,
  height: 120,
  getContext() {
    return {
      clearRect() {},
      fillRect(x, y, width, height) { calls.push([x, y, width, height]); },
      fillStyle: ""
    };
  }
};
assert.equal(W.draw(canvas, peaks), true);
assert.ok(calls.length >= 4, "waveform did not draw each peak");

const raw = new Uint8Array([1, 2, 3, 4]);
let decodedBytes = null;
context.window.atob = (value) => Buffer.from(value, "base64").toString("latin1");
context.window.cep = {
  fs: {
    readFile(path, encoding) {
      assert.equal(path, "C:/Media/test.mp3");
      assert.ok(encoding !== undefined, "base64 encoding was not requested");
      return { err: 0, data: Buffer.from(raw).toString("base64") };
    }
  },
  encoding: { Base64: 1 }
};
context.window.AudioContext = function () {
  return {
    decodeAudioData(data, success) {
      decodedBytes = Array.from(new Uint8Array(data));
      success(buffer);
    }
  };
};

await new Promise((resolveLoad, rejectLoad) => {
  W.load("C:/Media/test.mp3", 4, (error, loadedPeaks) => {
    try {
      assert.equal(error, null);
      assert.deepEqual(Array.from(loadedPeaks), peaks);
      assert.deepEqual(decodedBytes, Array.from(raw));
      resolveLoad();
    } catch (errorAssertion) {
      rejectLoad(errorAssertion);
    }
  });
});

console.log("[PASS] audio waveform reads, decodes and draws without ffmpeg");
