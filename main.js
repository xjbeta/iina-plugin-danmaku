/// <reference path="node_modules/iina-plugin-definition/iina/index.d.ts" />

const { core, console, event, mpv, http, menu, overlay, preferences, utils, file } = iina;
const item = menu.item("Danmaku");

let overlayShowing = false;
function showOverlay(osc=true) {
    overlay.show();
    if (osc) {
        core.osd("Show Danmaku.");
    };
};

function hideOverlay(osc=true) {
    overlay.hide();
    if (osc) {
        core.osd("Hide Danmaku.");
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

// Init MainMenu Item.
item.addSubMenuItem(menu.item("Select Danmaku File...", async () => {
    let path = await iina.utils.chooseFile('Select Danmaku File...', {'chooseDir': false, 'allowedFileTypes': ['xml']});
    xmlPath = path;
    loadDanmaku();
}));

item.addSubMenuItem(menu.separator());

item.addSubMenuItem(menu.item("Show / Hide Danmaku", () => {
    overlayShowing ? hideOverlay() : showOverlay();
}));

menu.addItem(item);


let danmakuWebLoaded = false;

function loadDanmaku() {
    if (!danmakuWebLoaded) {
        overlay.loadFile("DanmakuWeb/index.htm");
        danmakuWebLoaded = true;
    };
};

function unloadDanmaku() {
    if (danmakuWebLoaded) {
        overlay.loadFile("DanmakuWeb/index.htm");
        danmakuWebLoaded = false;
    };
};

iina.event.on("iina.plugin-overlay-loaded", () => {
    console.log('iina+ .plugin-overlay-loaded      ' + xmlPath);
    if (xmlPath) {
        showOverlay(false);

        overlay.postMessage("initDM", {});
        try {
            let json = JSON.parse(xmlPath);
            overlay.postMessage('initDanmakuOpts', json);
        } catch (error) {
            loadXMLFile(xmlPath);
        }
        xmlPath = undefined;
    }
});


iina.event.on("iina.window-will-close", () => {
    xmlPath = undefined;
    parsedOpts = [];
    unloadDanmaku();
});

iina.event.on("iina.pip.changed", (pip) => {
    console.log("PIP: " + pip);
});


iina.event.on("iina.file-started", () => {
    parseOpts();
});


iina.event.on("iina.window-resized", () => {
    overlay.postMessage("resizeWindow", {});
});

iina.event.on("mpv.pause.changed", (isPaused) => {
    overlay.postMessage("pauseChanged", {'isPaused': isPaused});
});


iina.event.on("mpv.time-pos.changed", (t) => {
    overlay.postMessage("timeChanged", {'time': t});
});