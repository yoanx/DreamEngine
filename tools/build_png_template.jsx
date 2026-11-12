// Rebuild DreamEnginePNG.aep without any imported footage.
// Run with After Effects 2021:
//   AfterFX.exe -r tools/build_png_template.jsx

(function buildPngTemplate() {
    var scriptFolder = new File($.fileName).parent;
    var outputPath = String($.getenv("DREAMENGINE_TEMPLATE_PATH") || "");
    var auditPath = String($.getenv("DREAMENGINE_TEMPLATE_AUDIT") || "");
    var output = new File(outputPath || (scriptFolder.fsName + "/DreamEnginePNG.aep"));
    var audit = new File(auditPath || (scriptFolder.fsName + "/DreamEnginePNG.audit.json"));

    app.beginSuppressDialogs();
    try {
        app.newProject();
        var comp = app.project.items.addComp("DE_RENDER_TARGET", 720, 720, 1, 1, 24);
        comp.layers.addSolid([0.08, 0.08, 0.08], "DE_BACKGROUND", 720, 720, 1);

        var queue = app.project.renderQueue.items.add(comp);
        var outputModule = queue.outputModule(1);
        var candidates = ["_HIDDEN Legacy PNG Sequence"];
        var templates = outputModule.templates || [];
        for (var i = 0; i < templates.length; i++) {
            if (String(templates[i]).toLowerCase().indexOf("png") >= 0) {
                candidates.push(String(templates[i]));
            }
        }
        candidates.push("PNG Sequence");
        candidates.push("PNG 序列");

        var applied = "";
        for (var c = 0; c < candidates.length; c++) {
            try {
                outputModule.applyTemplate(candidates[c]);
                applied = candidates[c];
                break;
            } catch (eTemplate) {}
        }
        if (!applied) throw new Error("No PNG output template available");

        var neutralTemp = new Folder("C:/Windows/Temp");
        if (!neutralTemp.exists) neutralTemp = Folder.temp;
        outputModule.file = new File(neutralTemp.fsName + "/DreamEngine_template_[####].png");
        queue.render = true;
        app.project.save(output);

        var items = [];
        for (var n = 1; n <= app.project.numItems; n++) {
            var item = app.project.item(n);
            var sourcePath = "";
            if (item instanceof FootageItem) {
                try {
                    sourcePath = item.mainSource && item.mainSource.file
                        ? item.mainSource.file.fsName
                        : "";
                } catch (eSource) {}
            }
            items.push({
                name: String(item.name || ""),
                type: item instanceof CompItem ? "comp" :
                    (item instanceof FootageItem ? "footage" : "folder"),
                sourcePath: sourcePath
            });
        }
        audit.encoding = "UTF-8";
        audit.open("w");
        audit.write("{\n");
        audit.write('  "outputModule": "' + applied.replace(/"/g, '\\"') + '",\n');
        audit.write('  "compFrameRate": ' + comp.frameRate + ',\n');
        audit.write('  "items": [\n');
        for (var a = 0; a < items.length; a++) {
            audit.write("    " + (a ? "," : "") + "{\"name\":\"" +
                items[a].name.replace(/\\/g, "\\\\").replace(/"/g, '\\"') +
                "\",\"type\":\"" + items[a].type + "\",\"sourcePath\":\"" +
                items[a].sourcePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"') +
                "\"}");
            audit.write("\n");
        }
        audit.write("  ]\n");
        audit.write("}\n");
        audit.close();
    } finally {
        try {
            if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
        } catch (eClose) {}
        app.endSuppressDialogs(false);
        app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
    }
})();
