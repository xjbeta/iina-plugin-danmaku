// ---------------------------------------------------------------------------
// Module Setup — references, plugin dependencies & state
// ---------------------------------------------------------------------------
/// <reference path="node_modules/iina-plugin-definition/iina/index.d.ts" />

const { core, console, event, mpv, http, menu, overlay, preferences, utils, file } = iina;

const instanceID = (Math.random() + 1).toString(36).substring(3);

let iinaPlusArgsKey = 'iinaPlusArgs=';
var iinaPlusOpts;
var optsParsed = false;

var danmakuWebLoaded = false;
var overlayShowing = false;
var mpvPaused = false;
var danmakuWebInited = false;

var stopped = true;

var mpvNewLoadfileAPI = false;
var mpvReloading = false;

// ---------------------------------------------------------------------------
// Utility — logging & hex encode/decode (iina-plus protocol compatible)
// ---------------------------------------------------------------------------
function print(str) {
    console.log('[' + instanceID + '] ' + str);
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
    print('remove parsed opts');
    mpv.set('referrer', '');
    mpv.set('script-opts', '');
};

// ---------------------------------------------------------------------------
// Overlay & Danmaku Layer — show/hide, load/unload, XML file
// ---------------------------------------------------------------------------
function showOverlay(osc=true) {
    print('showOverlay');
    overlay.show();
    if (osc) {
        core.osd("Show Danmaku.");
    };
    overlayShowing = true;
    setObserver(true);
    startWindowMainListener();
};

function hideOverlay(osc=true) {
    print('hideOverlay');
    overlay.hide();
    if (osc) {
        core.osd("Hide Danmaku.");
    };
    overlayShowing = false;
    setObserver(false);
    stopWindowMainListener();
};

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

function loadXMLFile(path) {
    print('loadXMLFile.' + 'path: ' + path);
    loadDanmaku();
    const content = iina.file.read(path);
    return stringToHex(content);
};

// ---------------------------------------------------------------------------
// Parse & Load — decode iinaPlus args, dispatch mpv loadfile
// ---------------------------------------------------------------------------
function parseOpts() {

    if (optsParsed) {
        print("parseOpts ignore: " + mpv.getString('path'));
        return;
    }

    let iinaPlusValue;

    let referrerHex = mpv.getString('referrer');
    if (referrerHex) {
        iinaPlusValue = iinaPlusArgsKey + referrerHex;
    } else {
        let scriptOpts = mpv.getString('script-opts');
        iinaPlusValue = scriptOpts?.split(',').find(s => s.startsWith(iinaPlusArgsKey));
    }

    if (!iinaPlusValue) {
        print("parseOpts: no iinaPlusArgs found");
        return;
    }

    optsParsed = true;
    removeOpts();

    print('iinaPlusValue' + iinaPlusValue);

    if (iinaPlusValue) {
        let opts = JSON.parse(hexToString(iinaPlusValue.substring(iinaPlusArgsKey.length)));
        print('iina plus opts: ' + JSON.stringify(opts));

        // Old entry: iina-plus protocol — opts carries video URLs, reload via mpv.
        if (opts.urls) {
            let mpvVer = iina.core.getVersion().mpv;
            let m = mpvVer.match(/\.(\d+)\./);
            let number = m ? parseInt(m[1], 10) : undefined;
            print('mpv version: ' + mpvVer);
            print('mpv number: ' + number);
            mpvNewLoadfileAPI = m ? number >= 38 : true;

            mpvLoadfile(opts.urls[opts.currentLine], opts.mpvScript);
        }

        iinaPlusOpts = opts;
        iinaPlusOpts.mpvScript = undefined;
        switch(opts.type) {
            case 0: // 0 ws
            case 1: // 1 xmlFile
                loadDanmaku();
                break;
            default: // 2 none
                break;
        };
    };
};

function mpvLoadfile(url, opts) {
    mpvReloading = true;
    if (mpvNewLoadfileAPI) {
        // v0.38.0 , svp 0.39.0
        mpv.command('loadfile', [url, 'replace', '0', opts]);
    } else {
        mpv.command('loadfile', [url, 'replace', opts]);
    };

    fdStart();
};

// ---------------------------------------------------------------------------
// Danmaku Web — init webview with options & preferences
// ---------------------------------------------------------------------------
function initDanmakuWeb() {
    if (iinaPlusOpts === undefined) {
        return;
    };

    switch (iinaPlusOpts.type) {
        case 0:
            break;
        case 1:
            iinaPlusOpts.xmlContent = loadXMLFile(iinaPlusOpts.xmlPath);
            break;
        default:
            return;
    };

    iinaPlusOpts.dmOpacity = iina.preferences.get('dmOpacity');
    iinaPlusOpts.dmSpeed = iina.preferences.get('dmSpeed');
    iinaPlusOpts.dmFont = iina.preferences.get('dmFont');

    var blockList = [];
    if (iina.preferences.get('blockTypeScroll') == 1) {
        blockList.push('Scroll');
    };
    if (iina.preferences.get('blockTypeTop') == 1) {
        blockList.push('Top');
    };
    if (iina.preferences.get('blockTypeBottom') == 1) {
        blockList.push('Bottom');
    };
    if (iina.preferences.get('blockTypeColor') == 1) {
        blockList.push('Color');
    };
    if (iina.preferences.get('blockTypeAdvanced') == 1) {
        blockList.push('Advanced');
    };
    iinaPlusOpts.blockType = blockList.join(',');


    showOverlay(false);
    overlay.postMessage("initDM", iinaPlusOpts);
    danmakuWebInited = true;
    print('initDM....');

    // Re-sync visibility — first setHidden from startWindowMainListener
    // arrived before initDM (before cm existed) and was dropped by the guard.
    overlay.postMessage("setHidden", { 'hidden': !core.window.visible });

    setObserver(true);
};

// ---------------------------------------------------------------------------
// Menu — danmaku file, show/hide, quality & line switching
// ---------------------------------------------------------------------------
function initMenuItems() {
    menu.removeAllItems();
    const danmakuMenuItem = menu.item("Danmaku");
    // Init MainMenu Item.
    danmakuMenuItem.addSubMenuItem(menu.item("Select Danmaku File...", async () => {
        let path = await iina.utils.chooseFile('Select Danmaku File...', {
            'chooseDir': false,
            'allowedFileTypes': ['xml']
        });
        iinaPlusOpts = {
            'xmlPath': path,
            'type': 1
        };
        loadDanmaku();
    }));

    danmakuMenuItem.addSubMenuItem(menu.separator());

    danmakuMenuItem.addSubMenuItem(menu.item("Show / Hide Danmaku", () => {
        overlayShowing ? hideOverlay() : showOverlay();
    }));

    menu.addItem(danmakuMenuItem);

    if (iinaPlusOpts === undefined) {
        return;
    };

    if (iinaPlusOpts.qualitys === undefined) {
        return;
    };

    const qualityItem = menu.item("Qualitys");
    iinaPlusOpts.qualitys.forEach((element, index) => {
        qualityItem.addSubMenuItem(menu.item(element, () => {
            requestNewUrl(element, iinaPlusOpts.currentLine)
        }, {
            selected: index == iinaPlusOpts.currentQuality
        }));
    });
    menu.addItem(qualityItem);

    if (iinaPlusOpts.lines === undefined) {
        return;
    };

    const lineItem = menu.item("Lines");
    iinaPlusOpts.lines.forEach((element, index) => {
        lineItem.addSubMenuItem(menu.item(element, () => {
            requestNewUrl(iinaPlusOpts.qualitys[iinaPlusOpts.currentQuality], index)
        }, {
            selected: index == iinaPlusOpts.currentLine
        }));
    });
    menu.addItem(lineItem);
};

// ---------------------------------------------------------------------------
// Request — fetch new URL on quality/line change from iina-plus server
// ---------------------------------------------------------------------------
function requestNewUrl(quality, line) {
    print(quality + line);

    let u = 'http://127.0.0.1:'+iinaPlusOpts.port+'/video';
    let pars = {'url': iinaPlusOpts.rawUrl, 'key': quality, 'pluginAPI': '1'};

    let timePos = iina.mpv.getNumber('time-pos')

    iina.http.get(u, {params: pars}).then((response) => {
        let re = JSON.parse(hexToString(response.text));
        let urls = re.urls;
        var url;
        if (line >= urls.length) {
            line = 0;
        };

        url = urls[line];

        iinaPlusOpts.qualitys = re.qualitys;
        iinaPlusOpts.currentQuality = re.qualitys.indexOf(quality);
        iinaPlusOpts.lines = re.lines;
        iinaPlusOpts.currentLine = line;

        if (iinaPlusOpts.type != 0 && re.mpvScript != undefined) {
            re.mpvScript += ',start=' + timePos;
        };

        mpvLoadfile(url, re.mpvScript);
        initMenuItems();
    }).catch((response) => {
        console.log(response)
    })
};

// ---------------------------------------------------------------------------
// Observers — mpv time-pos / window-scale listeners for overlay sync
// ---------------------------------------------------------------------------
var windowScaleListenerID, timePosListenerID;

// Window visibility: both triggers read core.window.visible (occlusionState)
// and use it as the single source of truth.
var windowMainListenerID;

function startWindowMainListener() {
    stopWindowMainListener();
    windowMainListenerID = event.on("iina.window-main.changed", () => {
        let visible = core.window.visible;
        print('Window main changed, visible=' + visible);
        overlay.postMessage("setHidden", { 'hidden': !visible });
    });
    // Sync initial state — catches the case where the plugin starts while
    // the window is already hidden (no event will fire in that scenario).
    let visible = core.window.visible;
    overlay.postMessage("setHidden", { 'hidden': !visible });
};

function stopWindowMainListener() {
    if (windowMainListenerID) {
        event.off("iina.window-main.changed", windowMainListenerID);
        windowMainListenerID = undefined;
    };
};

function setObserver(start) {
    let timePosKey = "mpv.time-pos.changed";
    let windowScaleKey = "mpv.window-scale.changed";

    function stop() {
        if (timePosListenerID) {
            iina.event.off(timePosKey, timePosListenerID);
            timePosListenerID = undefined;
        };
        if (windowScaleListenerID) {
            iina.event.off(windowScaleKey, windowScaleListenerID);
            windowScaleListenerID = undefined;
        };
    };

    if (start && !mpvPaused && danmakuWebLoaded && danmakuWebInited && overlayShowing) {
        print('Start Observers.');
        stop();
        if (iinaPlusOpts.type == 1) {
            timePosListenerID = iina.event.on(timePosKey, (t) => {
                overlay.postMessage("timeChanged", {'time': t});
            });
        };
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

// ---------------------------------------------------------------------------
// Lifecycle — teardown on end-file / stop
// ---------------------------------------------------------------------------
function deinit() {
    optsParsed = false;
    if (stopped) {
        return;
    };
    stopped = true;
    fdStop();
    setObserver(false);
    stopWindowMainListener();
    iinaPlusOpts = undefined;
    removeOpts();
    unloadDanmaku();
    overlayShowing = false;
    mpvPaused = false;
    danmakuWebInited = false;
};

// ---------------------------------------------------------------------------
// Event Registration — IINA / mpv lifecycle & state hooks
// ---------------------------------------------------------------------------
iina.event.on("iina.plugin-overlay-loaded", () => {
    print('iina.plugin-overlay-loaded');
    initDanmakuWeb();
});

// WKWebView visibilitychange → reads core.window.visible
overlay.onMessage("checkVisibility", () => {
    let visible = core.window.visible;
    print('checkVisibility: visible=' + visible);
    overlay.postMessage("setHidden", { 'hidden': !visible });
});

iina.event.on("mpv.start-file", () => {
    print('============================mpv.start-file============================');
    stopped = false;
    parseOpts();
    initMenuItems();
});

iina.event.on("mpv.end-file", () => {
    print('============================mpv.end-file============================');
    if (mpvReloading) {
        mpvReloading = false;
        return;
    }
    deinit();
});

iina.event.on("mpv.pause.changed", (isPaused) => {
    overlay.postMessage("pauseChanged", {'isPaused': isPaused});
    mpvPaused = isPaused;
    setObserver(!isPaused);
});

iina.event.on("iina.pip.changed", (pip) => {
    console.log("PIP: " + pip);
});

// ---------------------------------------------------------------------------
// Frame Drop Monitor — pause+resume on sustained frame drops
// Frame-Drop-Monitor-root-cause-zh-en.md
// ---------------------------------------------------------------------------
var fdStart, fdStop;
(function () {
    var running = false;
    var armed = false;
    var dropListenerID = null;
    var restartListenerID = null;
    var watchdog = null;
    var watchdogMs = 120000;
    var base = 0;
    var triggers = 0;
    var maxTriggers = 5;
    var cooldownMs = 5000;
    var lastTriggerAt = 0;
    var dropBaseFps = 60;
    var dropBaseCount = 60;
    var dropThreshold = null;

    function read() {
        try { return mpv.getNumber('frame-drop-count'); } catch (e) { return null; }
    }

    // threshold scales with fps
    function fpsThreshold() {
        if (dropThreshold !== null) return dropThreshold;
        let fps = 0;
        try { fps = mpv.getNumber('container-fps'); } catch (e) {}
        if (!fps || fps < 1) { try { fps = mpv.getNumber('estimated-vf-fps'); } catch (e2) {} }
        if (!fps || fps < 1) fps = dropBaseFps;
        dropThreshold = Math.max(30, Math.round(fps * dropBaseCount / dropBaseFps));
        return dropThreshold;
    }

    function onDrop(count) {
        if (triggers >= maxTriggers) return;
        if (Date.now() - lastTriggerAt < cooldownMs) return;
        let thr = fpsThreshold();
        if ((count - base) > thr) {
            triggers++;
            base = count;
            lastTriggerAt = Date.now();
            mpv.set('pause', true);
            mpv.set('pause', false);
            print('[FrameDrop] cum=' + count + ' exceeded ' + thr + ', pause+resume (' + triggers + '/' + maxTriggers + ').');
            resetWatchdog();
        }
    }

    function begin() {
        if (running) return;
        let d = read();
        if (d === null) return;
        running = true;
        base = d;
        triggers = 0;
        lastTriggerAt = 0;
        dropListenerID = iina.event.on("mpv.frame-drop-count.changed", onDrop);
        resetWatchdog();
        print('FrameDrop monitor started (max ' + maxTriggers + ', auto-stop ' + (watchdogMs / 1000) + 's)');
    }

    function arm() {
        if (armed) return;
        armed = true;
        restartListenerID = iina.event.on("mpv.playback-restart", () => { if (!mpvPaused) begin(); });
    }

    fdStart = function () {
        if (running && mpvReloading) {
            fdStop();
        }
        if (running) return;
        if (mpvPaused) { arm(); return; }
        let playing = false;
        try { playing = mpv.getNumber('time-pos') > 0; } catch (e) {}
        playing ? begin() : arm();
    };

    function resetWatchdog() {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
            print('[FrameDrop] no trigger in ' + (watchdogMs / 1000) + 's, stopping.');
            fdStop();
        }, watchdogMs);
    }

    fdStop = function () {
        running = false;
        if (dropListenerID) { iina.event.off("mpv.frame-drop-count.changed", dropListenerID); dropListenerID = null; }
        if (restartListenerID) { iina.event.off("mpv.playback-restart", restartListenerID); restartListenerID = null; }
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        armed = false;
        dropThreshold = null; // recompute for the next video's fps
        print('FrameDrop monitor stopped.');
    };
})();
