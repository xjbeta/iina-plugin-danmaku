/// <reference path="node_modules/iina-plugin-definition/iina/index.d.ts" />

const { core, console, event, mpv, http, menu, overlay, preferences, utils, file } = iina;

const item = menu.item("Danmaku");

function strToBuffer (string) {
    let arrayBuffer = new ArrayBuffer(string.length * 1);
    let newUint = new Uint8Array(arrayBuffer);
    newUint.forEach((_, i) => {
      newUint[i] = string.charCodeAt(i);
    });
    return newUint;
}


item.addSubMenuItem(menu.item("Show OSD", () => {
    core.osd("This is a demo message");
}))

item.addSubMenuItem(menu.item("Select Danmaku File...", async () => {
    const path = await iina.utils.chooseFile('Select Danmaku File...', {'chooseDir': false, 'allowedFileTypes': ['xml']});
    const content = await iina.file.read(path)

    overlay.postMessage("loadDM", {'content': JSON.stringify(content).slice(1, -1)})


    iina.event.on("iina.window-resized", () => {
        console.log('event, resizeWindow')
        overlay.postMessage("resizeWindow", {});
    });
    
    iina.event.on("mpv.time-pos.changed", (t) => {
        console.log('event, time-pos:' + t)
        overlay.postMessage("timeChanged", {'time': t});
    });
    
    iina.event.on("mpv.pause.changed", (isPaused) => {
        console.log('event, isPaused:' + isPaused)
        overlay.postMessage("pauseChanged", {'isPaused': isPaused});
    });
}))

item.addSubMenuItem(menu.separator());



menu.addItem(item);

iina.event.on("iina.pip.changed", (pip) => {
    console.log("PIP: " + pip)
});

iina.event.on("iina.window-loaded", () => {
    overlay.loadFile("DanmakuWeb/index.htm");
    overlay.show()
});

iina.event.on("iina.plugin-overlay-loaded", () => {
    overlay.postMessage("initDM", {});
});

