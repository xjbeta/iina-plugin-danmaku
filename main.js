/// <reference path="node_modules/iina-plugin-definition/iina/index.d.ts" />

const { core, console, event, mpv, http, menu, overlay, preferences, utils, file } = iina;
const item = menu.item("Danmaku");

var danmakuOpts;

var overlayShowing = false;
function showOverlay(osc=true) {
    overlay.show();
    if (osc) {
        core.osd("Show Danmaku.");
    };
    overlayShowing = true;
};

function hideOverlay(osc=true) {
    overlay.hide();
    if (osc) {
        core.osd("Hide Danmaku.");
    };
    overlayShowing = false;
};

function loadXMLFile(path) {
    loadDanmaku();
    const content = iina.file.read(path);
    overlay.postMessage("loadDM", {'content': JSON.stringify(content).slice(1, -1)});
};

function hexToString(hex) {
    hex = hex.replace( /../g , hex2=>('%'+hex2));
    return decodeURIComponent(hex);
};


let iinaPlusArgsKey = 'iinaPlusArgs=';
var optsParsed = false;

function removeOpts() {
    var v = mpv.getString('script-opts').split(',').filter(o => !o.startsWith(iinaPlusArgsKey)).join(',');
    mpv.set('script-opts', v);
};

function parseOpts() {
    if (optsParsed) {
        removeOpts();
        return;
    }

    let scriptOpts = mpv.getString('script-opts').split(',');

    
    let iinaPlusValue = scriptOpts.find(s => s.startsWith(iinaPlusArgsKey));
    if (iinaPlusValue) {
        optsParsed = true;

        let opts = JSON.parse(hexToString(iinaPlusValue.substring(iinaPlusArgsKey.length)));
        console.log('iina+  opts       '  + JSON.stringify(opts));

        if (opts.hasOwnProperty('mpvArgs')) {
            mpv.command('loadfile', opts.mpvArgs);
        };

        if (opts.hasOwnProperty('xmlPath') || (opts.hasOwnProperty('port') && opts.hasOwnProperty('uuid'))) {
            danmakuOpts = opts;
            loadDanmaku();
        };
    };
};

// Init MainMenu Item.
item.addSubMenuItem(menu.item("Select Danmaku File...", async () => {
    let path = await iina.utils.chooseFile('Select Danmaku File...', {'chooseDir': false, 'allowedFileTypes': ['xml']});
    danmakuOpts = {'xmlPath': path};
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
    if (!danmakuOpts) {
        return;
    };

    console.log('iina+ .plugin-overlay-loaded      ' + danmakuOpts);
    if (danmakuOpts.hasOwnProperty('xmlPath') || (danmakuOpts.hasOwnProperty('port') && danmakuOpts.hasOwnProperty('uuid'))) {
        showOverlay(false);
        overlay.postMessage("initDM", {});
    };

    if (danmakuOpts.hasOwnProperty('port') && danmakuOpts.hasOwnProperty('uuid')) {
        overlay.postMessage('initDanmakuOpts', {'port': danmakuOpts.port, 'uuid': danmakuOpts.uuid});
    };

    if (danmakuOpts.hasOwnProperty('xmlPath')) {
        loadXMLFile(danmakuOpts.xmlPath);
    };

    danmakuOpts = undefined;
});


iina.event.on("iina.window-will-close", () => {
    danmakuOpts = undefined;
    optsParsed = false;
    removeOpts();
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