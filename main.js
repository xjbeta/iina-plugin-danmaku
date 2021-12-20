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

var xmlPath;
function loadXMLFile(path) {
    loadDanmaku();
    const content = iina.file.read(path);
    overlay.postMessage("loadDM", {'content': JSON.stringify(content).slice(1, -1)});
};

function hexToString(hex) {
    hex = hex.substr(2);
    hex = hex.replace( /../g , hex2=>('%'+hex2));
    return decodeURIComponent(hex);
};

var parsedOpts = [];
function parseOpts() {
    let scriptOpts = mpv.getString('script-opts').split(',');
    if (parsedOpts.includes(scriptOpts)) {
        return;
    };
    parsedOpts.push(scriptOpts);

    console.log('iina+  scriptOpts       '  + scriptOpts);

    let iinaPlusKey = 'iinaPlusArgs=';
    let iinaPlusValue = scriptOpts.find(s => s.startsWith(iinaPlusKey));
    if (iinaPlusValue) {
        let args = JSON.parse(hexToString(iinaPlusValue.substring(iinaPlusKey.length))).args;
        mpv.command('loadfile', args);
        console.log('mpv.command  loadfile   ' + args);
    } else {
        let danmakuPluginKey = 'DanmakuPlugin=';
        let danmakuPluginValue = scriptOpts.find(s => s.startsWith(danmakuPluginKey));
        if (danmakuPluginValue) {
            xmlPath = hexToString(danmakuPluginValue.substring(danmakuPluginKey.length));
        } else {
            console.log('Not Find danmaku opts');
        };
    
        let xmlPathKey = 'DanmakuPluginXML=';
        let xmlPathValue = scriptOpts.find(s => s.startsWith(xmlPathKey));
        if (xmlPathValue) {
            xmlPath = hexToString(xmlPathValue.substring(xmlPathKey.length));
        } else {
            console.log('Not Find danmaku xml file path');
        };

        if (danmakuPluginValue || xmlPathValue) {
            console.log(xmlPath);
            loadDanmaku();
        };
    };
};

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