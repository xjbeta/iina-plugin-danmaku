/// <reference path="node_modules/iina-plugin-definition/iina/index.d.ts" />

const { core, console, event, mpv, http, menu, overlay, preferences, utils, file } = iina;
const item = menu.item("Danmaku");

let iinaPlusArgsKey = 'iinaPlusArgs=';
var danmakuOpts;
var optsParsed = false;

var danmakuWebLoaded = false;
var overlayShowing = false;
var mpvPaused = false;

function showOverlay(osc=true) {
    overlay.show();
    if (osc) {
        core.osd("Show Danmaku.");
    };
    overlayShowing = true;
    setObserver();
};

function hideOverlay(osc=true) {
    overlay.hide();
    if (osc) {
        core.osd("Hide Danmaku.");
    };
    overlayShowing = false;
    setObserver();
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

function loadDanmaku() {
    if (!danmakuWebLoaded) {
        overlay.loadFile("DanmakuWeb/index.htm");
        danmakuWebLoaded = true;
        setObserver();
    };
};

function unloadDanmaku() {
    if (danmakuWebLoaded) {
        overlay.loadFile("DanmakuWeb/index.htm");
        danmakuWebLoaded = false;
        setObserver();
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

iina.event.on("mpv.pause.changed", (isPaused) => {
    overlay.postMessage("pauseChanged", {'isPaused': isPaused});
    mpvPaused = isPaused;
    setObserver();
});


var windowScaleListenerID, timePosListenerID;

function setObserver() {
    let timePosKey = "mpv.time-pos.changed";
    let windowScaleKey = "mpv.window-scale.changed";

    if (danmakuWebLoaded && !mpvPaused && overlayShowing) {
        timePosListenerID = iina.event.on(timePosKey, (t) => {
            overlay.postMessage("timeChanged", {'time': t});
        });
        windowScaleListenerID = iina.event.on(windowScaleKey, () => {
            overlay.postMessage("resizeWindow", {});
        });
        initObserverValues();
    } else {

        iina.event.off(windowScaleKey, windowScaleListenerID);
        iina.event.off(timePosKey, timePosListenerID);
        timePosListenerID = undefined;
        windowScaleListenerID = undefined;
    };
};

function initObserverValues() {
    let t = mpv.getNumber('time-pos');
    overlay.postMessage("timeChanged", {'time': t});
    overlay.postMessage("resizeWindow", {});
};