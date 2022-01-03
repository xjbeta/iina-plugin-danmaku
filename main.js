/// <reference path="node_modules/iina-plugin-definition/iina/index.d.ts" />

const { core, console, event, mpv, http, menu, overlay, preferences, utils, file } = iina;
const item = menu.item("Danmaku");
const instanceID = (Math.random() + 1).toString(36).substring(3);

let iinaPlusArgsKey = 'iinaPlusArgs=';
var danmakuOpts;
var optsParsed = false;

var danmakuWebLoaded = false;
var overlayShowing = false;
var mpvPaused = false;
var danmakuWebInited = false;

function print(str) {
    console.log('[' + instanceID + '] ' + str);
};

function showOverlay(osc=true) {
    print('showOverlay');
    overlay.show();
    if (osc) {
        core.osd("Show Danmaku.");
    };
    overlayShowing = true;
    setObserver(true);
};

function hideOverlay(osc=true) {
    print('hideOverlay');
    overlay.hide();
    if (osc) {
        core.osd("Hide Danmaku.");
    };
    overlayShowing = false;
    setObserver(false);
};

function loadXMLFile(path) {
    print('loadXMLFile.' + 'path: ' + path);
    loadDanmaku();
    const content = iina.file.read(path);
    return stringToHex(content);
};

function stringToHex(str) {
    return Array.from(str).map(c => 
        c.charCodeAt(0) < 128 ? c.charCodeAt(0).toString(16).padStart(2, '0') :
        encodeURIComponent(c).replace(/\%/g,'').toLowerCase()
      ).join('');
};

function hexToString(hex) {
    return decodeURIComponent('%' + hex.match(/.{1,2}/g).join('%'));
};

function removeOpts() {
    print('remove parsed script-opts');
    var v = mpv.getString('script-opts').split(',').filter(o => !o.startsWith(iinaPlusArgsKey)).join(',');
    mpv.set('script-opts', v);
};

function parseOpts() {
    if (optsParsed) {
        removeOpts();
        return;
    };

    let scriptOpts = mpv.getString('script-opts').split(',');

    
    let iinaPlusValue = scriptOpts.find(s => s.startsWith(iinaPlusArgsKey));
    if (iinaPlusValue) {
        optsParsed = true;

        let opts = JSON.parse(hexToString(iinaPlusValue.substring(iinaPlusArgsKey.length)));
        print('iina plus opts: '  + JSON.stringify(opts));

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
        print('loadDanmaku');
        overlay.loadFile("DanmakuWeb/index.htm");
        danmakuWebLoaded = true;
    };
};

function unloadDanmaku() {
    if (danmakuWebLoaded) {
        print('unloadDanmaku');
        overlay.simpleMode();
        danmakuWebLoaded = false;
    };
};

function initDanmakuWeb() {
    if (!danmakuOpts) {
        return;
    };

    if (danmakuOpts.hasOwnProperty('xmlPath')) {
        danmakuOpts.xmlContent = loadXMLFile(danmakuOpts.xmlPath);
    };


    danmakuOpts.mpvArgs = undefined;
    danmakuOpts.xmlPath = undefined;

    if (danmakuOpts.hasOwnProperty('xmlPath') || (danmakuOpts.hasOwnProperty('port') && danmakuOpts.hasOwnProperty('uuid'))) {
        print('initDM.');
        showOverlay(false);
        overlay.postMessage("initDM", danmakuOpts);
        danmakuWebInited = true;
    };

    setObserver(true);
    danmakuOpts = undefined;
};

iina.event.on("iina.plugin-overlay-loaded", () => {
    print('iina.plugin-overlay-loaded');
    initDanmakuWeb();
});

iina.event.on("iina.window-will-close", () => {
    print('iina.window-will-close');
    danmakuOpts = undefined;
    optsParsed = false;
    removeOpts();
    unloadDanmaku();
});

iina.event.on("iina.pip.changed", (pip) => {
    console.log("PIP: " + pip);
});


iina.event.on("iina.file-started", () => {
    print('iina.file-started');
    parseOpts();
});

iina.event.on("mpv.pause.changed", (isPaused) => {
    overlay.postMessage("pauseChanged", {'isPaused': isPaused});
    mpvPaused = isPaused;
    setObserver(!isPaused);
});


var windowScaleListenerID, timePosListenerID;

function setObserver(start) {
    let timePosKey = "mpv.time-pos.changed";
    let windowScaleKey = "mpv.window-scale.changed";

    function stop() {
        if (timePosListenerID) {
            iina.event.off(windowScaleKey, windowScaleListenerID);
            iina.event.off(timePosKey, timePosListenerID);
            timePosListenerID = undefined;
            windowScaleListenerID = undefined;
        };
    };


    if (start && !mpvPaused && danmakuWebLoaded && danmakuWebInited && overlayShowing) {
        print('Start Observers.');
        if (timePosListenerID) {
            stop();
        };
        timePosListenerID = iina.event.on(timePosKey, (t) => {
            overlay.postMessage("timeChanged", {'time': t});
        });
        windowScaleListenerID = iina.event.on(windowScaleKey, () => {
            overlay.postMessage("resizeWindow", {});
        });
        initObserverValues();
    } else if (!start && (mpvPaused || !danmakuWebLoaded || !overlayShowing)) {
        print('Stop Observers.');
        stop();
    };
};

function initObserverValues() {
    print('init Observers.');
    let t = mpv.getNumber('time-pos');
    overlay.postMessage("timeChanged", {'time': t});
    overlay.postMessage("resizeWindow", {});
};