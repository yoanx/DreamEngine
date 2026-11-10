/* DreamEngine materials AE-side E2E probe. */
(function runMaterialsE2E() {
    var repo = new File($.fileName).parent.parent;
    var ext = repo.fsName + "/cep/com.dreamengine.panel";
    var probe = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    var fixture = new Folder(probe.fsName + "/materials_e2e_fixture");
    var report = new File(probe.fsName + "/materials_e2e.json");
    var result = "";

    function writeReport(text) {
        report.encoding = "UTF-8";
        report.open("w");
        report.write(text);
        report.close();
    }

    try {
        $.evalFile(new File(ext + "/engine/store.jsx"));
        $.evalFile(new File(ext + "/engine/materials.jsx"));
        var scanned = AEV_Materials.scanJson(fixture.fsName);
        var data = eval("(" + scanned + ")");
        var counts = { video: 0, image: 0, audio: 0, project: 0 };
        var imagePath = "";
        var projectPath = "";
        for (var i = 0; i < data.items.length; i++) {
            var item = data.items[i];
            if (counts[item.type] !== undefined) counts[item.type]++;
            if (item.type === "image" && !imagePath) imagePath = item.path;
            if (item.type === "project" && !projectPath) projectPath = item.path;
        }

        app.newProject();
        var comp = app.project.items.addComp("DE_material_e2e", 160, 90, 1, 5, 25);
        comp.openInViewer();
        comp.time = 1.25;
        var targetTime = Number(comp.time);
        var imported = imagePath
            ? AEV_Materials.importJson(imagePath, "image")
            : '{"status":"error","reason":"no_image"}';
        var importedData = eval("(" + imported + ")");
        var newLayer = comp.numLayers > 0 ? comp.layer(1) : null;
        var projectImported = projectPath
            ? AEV_Materials.importJson(projectPath, "project")
            : '{"status":"error","reason":"no_project"}';
        result = "{" +
            '"status":"ok",' +
            '"counts":{"video":' + counts.video + ',"image":' + counts.image +
            ',"audio":' + counts.audio + ',"project":' + counts.project + "}," +
            '"txtIgnored":' + (data.items.length === 5) + "," +
            '"videoPreview":' + (function () {
                for (var v = 0; v < data.items.length; v++) {
                    if (data.items[v].type === "video" && data.items[v].videoPreview) return true;
                }
                return false;
            })() + "," +
            '"audioWaveformInIndex":' + (function () {
                for (var a = 0; a < data.items.length; a++) {
                    if (data.items[a].type === "audio" && data.items[a].waveform) return true;
                }
                return false;
            })() + "," +
            '"imported":' + (imported.indexOf('"status":"ok"') >= 0) + "," +
            '"addedToComp":' + (!!newLayer) + "," +
            '"layerStartTime":' + (newLayer ? Number(newLayer.startTime) : -1) + "," +
            '"targetTime":' + targetTime + "," +
            '"projectImported":' + (projectImported.indexOf('"kind":"project"') >= 0) + "," +
            '"projectItems":' + app.project.numItems +
            "}";
        writeReport(result);
        try { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); } catch (eClose) {}
        try { app.quit(); } catch (eQuit) {}
    } catch (e) {
        result = '{"status":"error","reason":' + AEV_Materials.jsonString(e.toString()) + "}";
        try { writeReport(result); } catch (eWrite) {}
        try { if (app.project) app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); } catch (eClose2) {}
        try { app.quit(); } catch (eQuit2) {}
    }
})();
