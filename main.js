/// <reference path="node_modules/iina-plugin-definition/iina/index.d.ts" />

const { core, console, event, mpv, http, menu, overlay, preferences, utils, file } = iina;
const item = menu.item("Danmaku");


let overlayShowing = false;
function showOverlay(osc=true) {
    if (overlayShowing) {
        overlay.hide();
        core.osd("Hide Danmaku.");
    } else {
        overlay.show();
        
    }
    overlayShowing = !overlayShowing;

    if (osc) {
        let s = overlayShowing ? "Show" : "Hide"
        core.osd(s + " Danmaku.");
    };
};


item.addSubMenuItem(menu.item("Select Danmaku File...", async () => {
    const path = await iina.utils.chooseFile('Select Danmaku File...', {'chooseDir': false, 'allowedFileTypes': ['xml']});
    const content = await iina.file.read(path);
    
    if (!overlayShowing) {
        showOverlay(false);
    };

    overlay.postMessage("loadDM", {'content': JSON.stringify(content).slice(1, -1)});

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

item.addSubMenuItem(menu.item("Show / Hide Danmaku", () => {
    showOverlay();
}))


menu.addItem(item);

iina.event.on("iina.pip.changed", (pip) => {
    console.log("PIP: " + pip);
});

iina.event.on("iina.window-loaded", () => {
    overlay.loadFile("DanmakuWeb/index.htm");
    overlay.show();
    overlayShowing = true;
});

iina.event.on("iina.plugin-overlay-loaded", () => {
    overlay.postMessage("initDM", {});
});

iina.event.on("iina.window-will-close", () => {
    overlay.postMessage("close", {});
    overlay.simpleMode();
});