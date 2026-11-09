(function () {
    var probe = new Folder(Folder.myDocuments.fsName + "/DreamEngineProbe");
    var pathFile = new File(probe.fsName + "/plugin_preview_script_path.txt");
    var errorFile = new File(probe.fsName + "/plugin_preview_loader_error.txt");

    pathFile.encoding = "UTF-8";
    if (!pathFile.open("r")) {
        errorFile.encoding = "UTF-8";
        errorFile.open("w");
        errorFile.write("cannot_open_script_path");
        errorFile.close();
        return;
    }
    var sourcePath = pathFile.read().replace(/[\r\n]+/g, "");
    pathFile.close();
    var source = new File(sourcePath);

    source.encoding = "UTF-8";
    if (!source.open("r")) {
        errorFile.encoding = "UTF-8";
        errorFile.open("w");
        errorFile.write("cannot_open_source");
        errorFile.close();
        return;
    }
    var script = source.read();
    source.close();

    try {
        eval(script);
    } catch (e) {
        errorFile.encoding = "UTF-8";
        errorFile.open("w");
        errorFile.write(String(e) + "\nline=" + String(e.line));
        errorFile.close();
        try {
            app.quit(SaveOptions.DO_NOT_SAVE_CHANGES);
        } catch (e2) {
            app.quit();
        }
    }
})();
