#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = resolve(ROOT, "cep/com.dreamengine.panel/engine/materials.jsx");
const context = vm.createContext({});
vm.runInContext(readFileSync(SOURCE, "utf8"), context, { filename: "materials.jsx" });
const M = context.AEV_Materials;

assert.equal(M.classify("clip.MP4"), "video");
assert.equal(M.classify("clip.mov"), "video");
assert.equal(M.classify("clip.mxf"), "video");
assert.equal(M.classify("photo.JPEG"), "image");
assert.equal(M.classify("photo.webp"), "image");
assert.equal(M.classify("voice.wav"), "audio");
assert.equal(M.classify("voice.flac"), "audio");
assert.equal(M.classify("project.aep"), "project");
assert.equal(M.classify("tool.jsx", "C:/Media/scripts/tool.jsx"), "script");
assert.equal(M.classify("tool.jsxbin", "C:/Media/scripts/tool.jsxbin"), "script");
assert.equal(M.classify("blink.expression"), "");
assert.equal(M.classify("弹性表达式.txt", "C:/Media/notes/弹性表达式.txt"), "");
assert.equal(M.classify("notes.txt"), "");
assert.equal(M.classify("folder.aepx"), "");

const parsed = M.parseTsv(
  M.indexHeader() +
    "\n" +
    "C:/素材/声音.wav\t声音.wav\taudio\t.wav\t12\t123\ttrue\n",
);
assert.equal(parsed.length, 1);
assert.equal(parsed[0].type, "audio");
assert.equal(parsed[0].path, "C:/素材/声音.wav");
assert.equal(parsed[0].exists, true);
assert.match(M.rowToJson(parsed[0]), /"type":"audio"/);
const previewRow = Object.assign({}, parsed[0], {
  waveform: "C:/docs/materials/waveforms/abc.png",
  videoPreview: "C:/docs/materials/video-previews/abc.mp4"
});
assert.match(M.rowToJson(previewRow), /"waveform":"C:\/docs\/materials\/waveforms\/abc.png"/);
assert.match(M.rowToJson(previewRow), /"videoPreview":"C:\/docs\/materials\/video-previews\/abc.mp4"/);

assert.equal(
  M.cacheKey("C:/Media/sound.wav", 12, 123, "waveform"),
  M.cacheKey("C:/Media/sound.wav", 12, 123, "waveform"),
);
assert.notEqual(
  M.cacheKey("C:/Media/sound.wav", 12, 123, "waveform"),
  M.cacheKey("C:/Media/sound.wav", 13, 123, "waveform"),
);

function makeScanContext() {
  const files = {};
  const omittedPaths = new Set();

  function visible(entries) {
    return entries.filter((entry) => !omittedPaths.has(entry.fsName));
  }

  class FileMock {
    constructor(path, size, modifiedAt, displayName) {
      this.fsName = path;
      this.name = displayName || path.replace(/\\/g, "/").split("/").pop();
      this.length = size;
      this.modified = new Date(modifiedAt);
      this.exists = true;
    }
  }

  class FolderMock {
    constructor(path) {
      this.fsName = String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
      this.name = this.fsName.split("/").pop();
      this.exists = this.fsName === "C:/Media" || this.fsName === "C:/Other";
      this.modified = new Date(0);
    }

    getFiles() {
      if (this.fsName !== "C:/Media") return [];
      const nested = new FolderMock("C:/Media/nested");
      nested.exists = true;
      return visible([
        new FileMock("C:/Media/clip.mp4", 100, 10, "%E5%89%AA%E8%BE%91.mp4"),
        new FileMock("C:/Media/image.png", 50, 20),
        new FileMock("C:/Media/sound.wav", 25, 30),
        new FileMock("C:/Media/project.aep", 80, 40),
        new FileMock("C:/Media/tool.jsx", 12, 45),
        new FileMock("C:/Media/readme.txt", 5, 50),
        nested,
      ]);
    }
  }

  FolderMock.prototype.getFiles = function () {
    if (this.fsName === "C:/Media") {
      const nested = new FolderMock("C:/Media/nested");
      nested.exists = true;
      return visible([
        new FileMock("C:/Media/clip.mp4", 100, 10, "%E5%89%AA%E8%BE%91.mp4"),
        new FileMock("C:/Media/image.png", 50, 20),
        new FileMock("C:/Media/sound.wav", 25, 30),
        new FileMock("C:/Media/project.aep", 80, 40),
        new FileMock("C:/Media/tool.jsx", 12, 45),
        new FileMock("C:/Media/readme.txt", 5, 50),
        nested,
      ]);
    }
    if (this.fsName === "C:/Media/nested") {
      return visible([new FileMock("C:/Media/nested/nested.MOV", 70, 60)]);
    }
    if (this.fsName === "C:/Other") {
      return visible([new FileMock("C:/Other/other.png", 15, 70)]);
    }
    return [];
  };

  const context = vm.createContext({
    Folder: FolderMock,
    File: FileMock,
    AEV_Store: {
      files,
      resolve(relative) {
        return "C:/docs/" + relative;
      },
      writeText(relative, text) {
        files[relative] = String(text);
        return "OK:" + relative;
      },
      readText(relative) {
        return files[relative] || "";
      },
    },
  });
  vm.runInContext(readFileSync(SOURCE, "utf8"), context, { filename: "materials.jsx" });
  context.removeMediaFile = function (path) {
    omittedPaths.add(path);
  };
  return context;
}

const scanContext = makeScanContext();
const result = JSON.parse(scanContext.AEV_Materials.scanJson("C:/Media"));
assert.equal(result.status, "ok");
assert.equal(result.items.length, 6);
assert.equal(result.items.filter((item) => item.type === "video").length, 2);
assert.equal(result.items.filter((item) => item.type === "script").length, 1);
assert.equal(
  result.items.find((item) => item.path === "C:/Media/clip.mp4").name,
  "剪辑.mp4",
  "ExtendScript 返回的 URL 编码文件名应在索引入口解码",
);
const audioItem = result.items.find((item) => item.path === "C:/Media/sound.wav");
assert.equal(audioItem.waveform, undefined, "audio waveform must be generated in the CEP panel");
assert.equal(audioItem.previewKey, undefined, "audio should not request an ffmpeg preview");
assert.doesNotMatch(
  readFileSync(SOURCE, "utf8"),
  /showwavespic/,
  "audio waveform must not depend on ffmpeg",
);
assert.match(scanContext.AEV_Store.files["materials/index.tsv"], /#ROOT\tC:\/Media/);
assert.match(scanContext.AEV_Store.files["materials/index.json"], /"type":"project"/);
assert.match(scanContext.AEV_Store.files["materials/index.json"], /"count":6/);
assert.match(
  scanContext.AEV_Materials.scanJson("C:/Missing"),
  /"reason":"root_missing"/,
);

scanContext.Folder.selectDialog = function () {
  return new scanContext.Folder("C:/Media");
};
const picked = JSON.parse(scanContext.AEV_Materials.pickRootJson());
assert.equal(picked.status, "ok");
assert.equal(picked.root, "C:/Media");

scanContext.removeMediaFile("C:/Media/sound.wav");
const refreshed = JSON.parse(scanContext.AEV_Materials.scanJson("C:/Media"));
assert.equal(refreshed.items.length, 6);
const missingAudio = refreshed.items.find((item) => item.path === "C:/Media/sound.wav");
assert.equal(missingAudio.exists, false);
assert.equal(missingAudio.waveform, undefined);
assert.match(
  scanContext.AEV_Store.files["materials/index.tsv"],
  /C:\/Media\/sound\.wav\t.*\tfalse/,
);

const otherRoot = JSON.parse(scanContext.AEV_Materials.scanJson("C:/Other"));
assert.equal(otherRoot.items.length, 1);
assert.equal(otherRoot.items[0].path, "C:/Other/other.png");

function makeImportContext(hasProject, fileExists) {
  const calls = [];
  const items = [];
  const layers = [];
  const comp = {
    time: 3.5,
    duration: 12,
    layers: {
      add(item) {
        const layer = {
          item,
          startTime: 0,
          inPoint: 0,
          outPoint: 12,
          selected: false,
        };
        layers.push(layer);
        return layer;
      },
      length: 0,
    },
    layer() {
      return null;
    },
    selectedLayers: [],
  };
  class FileImportMock {
    constructor(path) {
      this.fsName = path;
      this.exists = fileExists;
    }
  }
  const context = vm.createContext({
    app: hasProject
      ? {
          project: {
            activeItem: comp,
            items: { length: 0 },
            importFile(options) {
              calls.push(options.file.fsName);
              const item = {
                selected: false,
                file: { fsName: options.file.fsName },
              };
              items.push(item);
              return item;
            },
          },
        }
      : {
          project: null,
        },
    File: FileImportMock,
    Folder: function () {},
    ImportOptions: function (file) {
      this.file = file;
    },
    CompItem: function CompItem() {},
    AEV_Store: {
      readText() { return ""; },
      writeText() { return "OK"; },
    },
  });
  if (hasProject) {
    Object.setPrototypeOf(context.app.project.activeItem, context.CompItem.prototype);
  }
  vm.runInContext(readFileSync(SOURCE, "utf8"), context, { filename: "materials.jsx" });
  return { context, calls, items, layers, comp };
}

const noProject = makeImportContext(false, true);
assert.match(
  noProject.context.AEV_Materials.importJson("C:/Media/clip.mp4"),
  /"reason":"no_project"/,
);

const missing = makeImportContext(true, false);
assert.match(
  missing.context.AEV_Materials.importJson("C:/Media/missing.mp4"),
  /"reason":"file_missing"/,
);

const imported = makeImportContext(true, true);
assert.equal(
  JSON.parse(imported.context.AEV_Materials.importJson("C:/Media/clip.mp4", "video")).status,
  "ok",
);
assert.deepEqual(imported.calls, ["C:/Media/clip.mp4"]);
assert.equal(imported.items[0].selected, true);
assert.equal(imported.layers.length, 1, "双击素材后应添加到当前合成");
assert.equal(imported.layers[0].startTime, 3.5, "新图层应对齐当前时间指示器");
assert.equal(imported.layers[0].selected, true, "新图层应被选中");

const projectImport = makeImportContext(true, true);
const projectResult = JSON.parse(
  projectImport.context.AEV_Materials.importJson("C:/Media/project.aep", "project"),
);
assert.equal(projectResult.status, "ok");
assert.equal(projectResult.kind, "project");
assert.equal(projectImport.layers.length, 0, ".aep 只能导入项目，不能添加到合成");

const reused = makeImportContext(true, true);
const existingItem = reused.context.app.project.importFile(
  new reused.context.ImportOptions(new reused.context.File("C:/Media/clip.mp4")),
);
reused.context.app.project.items = { length: 1, 1: existingItem };
const reusedCallsBefore = reused.calls.length;
assert.equal(
  JSON.parse(reused.context.AEV_Materials.importJson("C:/Media/clip.mp4", "video")).status,
  "ok",
);
assert.equal(reused.calls.length, reusedCallsBefore, "已导入素材不应重复创建项目条目");

console.log("materials classification/index/scan/import tests passed");
