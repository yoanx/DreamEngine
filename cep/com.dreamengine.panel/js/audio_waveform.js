/* ============================================================
 * audio_waveform.js - CEP-native audio waveform generation
 *
 * The panel reads a local file through window.cep.fs, decodes it with
 * Web Audio and draws peak columns on a canvas. No external executable
 * or generated PNG is involved.
 *
 * Syntax: ES5 only.
 * ============================================================ */

var AEV_AudioWaveform = (function () {
  var audioContext = null;

  function getAudioContext() {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!audioContext) {
      try {
        audioContext = new Ctor();
      } catch (e) {
        return null;
      }
    }
    return audioContext;
  }

  function readFileBuffer(path) {
    if (!window.cep || !window.cep.fs || typeof window.cep.fs.readFile !== "function") {
      throw new Error("cep_fs_unavailable");
    }
    var encoding = window.cep.encoding && window.cep.encoding.Base64;
    if (encoding === undefined) throw new Error("base64_unavailable");
    var result = window.cep.fs.readFile(path, encoding);
    if (!result || result.err !== 0 || !result.data) throw new Error("read_failed");

    var binary = window.atob(result.data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function peaksFromBuffer(buffer, columns) {
    var count = Math.max(1, Math.floor(Number(columns) || 256));
    var length = buffer && Number(buffer.length) || 0;
    if (!length || !buffer.getChannelData) return [];

    var channelCount = Math.max(1, Math.min(4, Number(buffer.numberOfChannels) || 1));
    var channels = [];
    for (var c = 0; c < channelCount; c++) channels.push(buffer.getChannelData(c));

    var peaks = [];
    var maxPeak = 0;
    for (var i = 0; i < count; i++) {
      var start = Math.floor(i * length / count);
      var end = Math.floor((i + 1) * length / count);
      if (end <= start) end = Math.min(length, start + 1);
      var stride = Math.max(1, Math.floor((end - start) / 128));
      var peak = 0;

      for (var ch = 0; ch < channels.length; ch++) {
        var data = channels[ch];
        for (var j = start; j < end; j += stride) {
          var value = Math.abs(Number(data[j]) || 0);
          if (value > peak) peak = value;
        }
      }
      peaks.push(peak);
      if (peak > maxPeak) maxPeak = peak;
    }

    if (maxPeak > 0) {
      for (var k = 0; k < peaks.length; k++) peaks[k] = Math.min(1, peaks[k] / maxPeak);
    }
    return peaks;
  }

  function draw(canvas, peaks) {
    if (!canvas || !canvas.getContext || !peaks || !peaks.length) return false;
    var width = Math.max(1, Number(canvas.width) || 320);
    var height = Math.max(1, Number(canvas.height) || 120);
    var context = canvas.getContext("2d");
    if (!context) return false;

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#8fa3ad";
    var step = width / peaks.length;
    var center = height / 2;
    var maxHalf = height * 0.44;
    var drew = false;

    for (var i = 0; i < peaks.length; i++) {
      var half = Math.max(0.75, Math.min(1, Number(peaks[i]) || 0) * maxHalf);
      var x = Math.round(i * step);
      var barWidth = Math.max(1, Math.ceil(step) - 1);
      context.fillRect(x, Math.round(center - half), barWidth, Math.max(1, Math.round(half * 2)));
      drew = true;
    }
    if (!drew) context.fillRect(0, Math.round(center), width, 1);
    return true;
  }

  function load(path, columns, callback) {
    var bytes;
    var context = getAudioContext();
    if (!context) {
      callback("audio_context_unavailable");
      return;
    }
    try {
      bytes = readFileBuffer(path);
    } catch (readError) {
      callback(String(readError && readError.message || readError));
      return;
    }

    var finished = false;
    function fail(error) {
      if (finished) return;
      finished = true;
      callback("decode_failed:" + String(error && error.message || error || "unknown"));
    }
    function ready(buffer) {
      if (finished) return;
      finished = true;
      var peaks = peaksFromBuffer(buffer, columns);
      callback(peaks.length ? null : "empty_audio", peaks);
    }

    try {
      var pending = context.decodeAudioData(bytes, ready, fail);
      if (pending && pending.then) pending.then(ready, fail);
    } catch (decodeError) {
      fail(decodeError);
    }
  }

  return {
    peaksFromBuffer: peaksFromBuffer,
    draw: draw,
    load: load
  };
})();
