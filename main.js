// ---------------------------------------------------------------------------
// Module Setup — references, plugin dependencies & state
// Design doc: Ytdl-Option-Loading-and-IINA-Open-Flow-zh-en.md
// ---------------------------------------------------------------------------
/// <reference path="node_modules/iina-plugin-definition/iina/index.d.ts" />

const { core, console, event, mpv, http, menu, overlay, preferences, utils, file } = iina;

const instanceID = (Math.random() + 1).toString(36).substring(3);

let iinaPlusArgsKey = 'iinaPlusArgs=';
var iinaPlusOpts;
var optsParsed = false;

// iinaPlusArgs parsed in on_load, handed to start-file for one-time consumption (doc §3)
var hookArgsForMainThread;

var danmakuWebLoaded = false;
var overlayShowing = false;
var mpvPaused = false;
var danmakuWebInited = false;

var stopped = true;

// in-flight plugin reload; swallows the mpv.end-file that follows it
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
    overlay.show();
    if (osc) {
        core.osd("Show Danmaku.");
    };
    overlayShowing = true;
    setObserver(true);
    startWindowMainListener();
};

function hideOverlay(osc=true) {
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
        overlay.loadFile("DanmakuWeb/index.htm");
        danmakuWebLoaded = true;
    };
};

function unloadDanmaku() {
    if (danmakuWebLoaded) {
        overlay.simpleMode();
        danmakuWebLoaded = false;
    };
};

function loadXMLFile(path) {
    print('loadXMLFile.path: ' + path);
    loadDanmaku();
    const content = iina.file.read(path);
    return stringToHex(content);
};

// ---------------------------------------------------------------------------
// Parse & Load — decode iinaPlus args, dispatch mpv loadfile
// ---------------------------------------------------------------------------
// payload = stringToHex() output; channel may be dirtied, so validate before hexToString (doc §3)
function isIinaPlusHexPayload(payload) {
    return !!payload && payload.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(payload);
}

function readIinaPlusValue() {
    let referrerHex = mpv.getString('referrer');
    if (referrerHex) {
        if (isIinaPlusHexPayload(referrerHex)) {
            return iinaPlusArgsKey + referrerHex;
        }
        // leave the dirty value untouched — it is the site Referer the main file needs
        return undefined;
    }
    let fromScriptOpts = mpv.getString('script-opts')?.split(',').find(s => s.startsWith(iinaPlusArgsKey));
    if (!fromScriptOpts) {
        return undefined;
    }
    if (!isIinaPlusHexPayload(fromScriptOpts.substring(iinaPlusArgsKey.length))) {
        return undefined;
    }
    return fromScriptOpts;
}

function decodeIinaPlusValue(iinaPlusValue) {
    return JSON.parse(hexToString(iinaPlusValue.substring(iinaPlusArgsKey.length)));
}

function markIinaPlusArgsConsumed() {
    optsParsed = true;
    removeOpts();
}

// main-thread path: parse and consume; the hook's read-only probe is peekIinaPlusArgs
function consumeIinaPlusArgs() {
    let iinaPlusValue = readIinaPlusValue();
    if (!iinaPlusValue) {
        return undefined;
    }

    // parse failure degrades to "absent"; consume only on success, leave channels untouched on failure
    let opts;
    try {
        opts = decodeIinaPlusValue(iinaPlusValue);
    } catch (e) {
        print('decode iinaPlusArgs failed: ' + e);
        return undefined;
    }

    markIinaPlusArgsConsumed();

    print('iinaPlusValue' + iinaPlusValue);
    print('iina plus opts: ' + JSON.stringify(opts));

    let mpvVer = iina.core.getVersion().mpv;
    print('mpv version: ' + mpvVer);

    return opts;
}

// read-only probe for the hook (controller queue): no consumption, no state
function peekIinaPlusArgs() {
    let iinaPlusValue = readIinaPlusValue();
    if (!iinaPlusValue) {
        return undefined;
    }
    try {
        return decodeIinaPlusValue(iinaPlusValue);
    } catch (e) {
        print('peekIinaPlusArgs error: ' + e);
        return undefined;
    }
}

function applyIinaPlusArgs(opts) {
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

function parseOpts() {

    if (optsParsed) {
        print("parseOpts ignore: " + mpv.getString('path'));
        return;
    }

    let opts = hookArgsForMainThread;
    hookArgsForMainThread = undefined;
    if (opts) {
        markIinaPlusArgsConsumed();
        print('iina plus opts (from hook): ' + JSON.stringify(opts));
    } else {
        opts = consumeIinaPlusArgs();
    }
    if (!opts) {
        print("parseOpts: no iinaPlusArgs found");
        return;
    }

    // hook missed the redirect (e.g. direct URL): fall back to one loadfile, never with undefined
    if (opts.urls && !loadHookDidRedirect()) {
        let realUrl = opts.urls[opts.currentLine];
        if (realUrl) {
            mpvLoadfile(realUrl, opts.mpvScript);
        } else {
            print('parseOpts: no url for currentLine=' + opts.currentLine + ', skip fallback loadfile');
        }
    }

    applyIinaPlusArgs(opts);
};

// bare loadfile; per-file options are applied by the Load Hook in on_load
function mpvLoadfile(url, opts) {
    mpvReloading = true;
    loadHookLoad(url, opts);
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

    // re-sync: the early setHidden was dropped and pauseChanged may not fire for a fresh file
    overlay.postMessage("setHidden", { 'hidden': !core.window.visible });
    overlay.postMessage("pauseChanged", { 'isPaused': mpvPaused });

    setObserver(true);
};

// ---------------------------------------------------------------------------
// Menu — danmaku file, show/hide, quality & line switching
// ---------------------------------------------------------------------------
function initMenuItems() {
    menu.removeAllItems();
    const danmakuMenuItem = menu.item("Danmaku");
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
            requestNewUrl(element, iinaPlusOpts.currentLine);
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
            requestNewUrl(iinaPlusOpts.qualitys[iinaPlusOpts.currentQuality], index);
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

    let u = 'http://127.0.0.1:' + iinaPlusOpts.port + '/video';
    let pars = {'url': iinaPlusOpts.rawUrl, 'key': quality, 'pluginAPI': '1'};

    let timePos = iina.mpv.getNumber('time-pos');

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
        print('requestNewUrl error: ' + response);
    });
};

// ---------------------------------------------------------------------------
// Observers — mpv time-pos / window-scale listeners for overlay sync
// ---------------------------------------------------------------------------
var windowScaleListenerID, timePosListenerID;

// two channels feed visibility: the window-main event and a low-frequency poll (covers Space switches)
var windowMainListenerID;
var visibilityPollTimer;
const VISIBILITY_POLL_MS = 500;

function reportVisibility() {
    overlay.postMessage("setHidden", { 'hidden': !core.window.visible });
};

function startWindowMainListener() {
    stopWindowMainListener();
    windowMainListenerID = event.on("iina.window-main.changed", reportVisibility);
    // sync initial state: no event fires when the window is already hidden
    reportVisibility();
    stopVisibilityPoll();
    visibilityPollTimer = setInterval(reportVisibility, VISIBILITY_POLL_MS);
};

function stopWindowMainListener() {
    if (windowMainListenerID) {
        event.off("iina.window-main.changed", windowMainListenerID);
        windowMainListenerID = undefined;
    };
    stopVisibilityPoll();
};

function stopVisibilityPoll() {
    if (visibilityPollTimer) {
        clearInterval(visibilityPollTimer);
        visibilityPollTimer = undefined;
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
        // before start-file, loadHookReset is skipped and the hook's handover may linger (guarded in handleOnLoad)
        print('deinit skipped: stopped=true (before start-file)');
        return;
    };
    stopped = true;
    setObserver(false);
    stopWindowMainListener();
    iinaPlusOpts = undefined;
    loadHookReset();
    removeOpts();
    unloadDanmaku();
    overlayShowing = false;
    mpvPaused = false;
    danmakuWebInited = false;
};

// ---------------------------------------------------------------------------
// Event Registration — IINA / mpv lifecycle & state hooks
// ---------------------------------------------------------------------------

print('plugin loaded  instance=' + instanceID + '  mpv=' + core.getVersion().mpv);

iina.event.on("iina.plugin-overlay-loaded", () => {
    print('iina.plugin-overlay-loaded');
    initDanmakuWeb();
});

// audio-file can't be set via file-local-options (mpv 0.38 returned -3); attach pending external audio here
iina.event.on("iina.file-loaded", () => {
    loadHookApplyPendingAudio();
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
    print("PIP: " + pip);
});

// ---------------------------------------------------------------------------
// Load Hook — on_load: redirect + per-file options
// ---------------------------------------------------------------------------
// Registered on module evaluation (before any load). Why a hook and how the
// parsed args are handed over: doc §1 / §3.
// ---------------------------------------------------------------------------
var loadHookLoad, loadHookDidRedirect, loadHookApplyPendingAudio, loadHookReset;
(function () {
    var pending = null;             // per-file opts registered by loadHookLoad, consumed in on_load
    var redirected = false;         // initial load already redirected → start-file skips fallback load
    var pendingAudio = [];          // audio files to attach via audio-add after file-loaded
    var pendingAudioReferrer = '';  // global referrer written before attaching tracks

    // iina-plus local endpoint (/huya/<uuid>.flv is playable as-is, never redirect)
    var endpointPattern = /^https?:\/\/127\.0\.0\.1:\d+\/video\.mp4/;

    // write target: probe `file-local-options/<name>` first, else global — mpv.set failures are
    // silent on the IINA side (return code dropped), so probing is the only reliable distinction
    // (never route via `option-info/<name>/expects-file`: it takes a path, not a track)
    function applyPerFileOptions(optionString) {
        if (!optionString) {
            return;
        }
        parseOptionString(optionString).forEach(function (kv) {
            var name = kv[0];
            var value = kv[1];

            // path-based track options are `-append` aliases, unassignable at runtime (-3 on 0.38)
            // and renamed on 0.41 (audio-files / external-files) → always audio-add, match by family
            if (/^(audio|external)-file/.test(name)) {
                pendingAudio.push(value);
                return;
            }
            // same value is reused for external tracks (pendingAudioReferrer)
            if (name === 'referrer') {
                pendingAudioReferrer = value;
            }

            var target = 'file-local-options/' + name;
            var probe = mpv.getString(target);
            if (probe === undefined || probe === null) {
                print('per-file option unknown to this mpv, set globally: ' + name);
                mpv.set(name, value);
                return;
            }
            mpv.set(target, value);
        });
    };

    // split on commas, but respect quotes (mpvScript titles may contain commas)
    function parseOptionString(str) {
        if (!str) {
            return [];
        }
        var parts = [];
        var buf = '';
        var inQuote = false;
        for (var i = 0; i < str.length; i++) {
            var c = str.charAt(i);
            if (c === '"') {
                inQuote = !inQuote;
                buf += c;
                continue;
            }
            if (c === ',' && !inQuote) {
                parts.push(buf);
                buf = '';
                continue;
            }
            buf += c;
        }
        parts.push(buf);

        var result = [];
        parts.forEach(function (part) {
            var idx = part.indexOf('=');
            if (idx <= 0) {
                return;
            }
            var name = part.substring(0, idx).trim();
            var value = part.substring(idx + 1).trim();
            if (value.length >= 2 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"') {
                value = value.substring(1, value.length - 1);
            }
            result.push([name, value]);
        });
        return result;
    };

    function handleOnLoad() {
        pendingAudio = [];              // fresh option set per load
        pendingAudioReferrer = '';

        var url = mpv.getString('stream-open-filename');
        var isEndpoint = endpointPattern.test(url);
        print('on_load: ' + url);

        // (1) plugin-initiated load → apply the registered per-file options
        if (pending && pending.url === url) {
            var current = pending;
            pending = null;
            print('on_load: apply per-file options (plugin load)');
            applyPerFileOptions(current.options);
            return;
        }
        if (pending) {
            print('on_load: url mismatch with pending load. pending=' + pending.url);
        }

        // (2) initial load: IINA opened the local endpoint → swap in the real URL (controller queue, mpv-only I/O)
        if (!optsParsed && isEndpoint) {
            var opts = peekIinaPlusArgs();
            if (!opts) {
                print('on_load: keep original load, no iinaPlusArgs for endpoint');
                return;
            }
            hookArgsForMainThread = opts;   // hand over before the referrer write below overwrites the channel
            var realUrl = opts.urls ? opts.urls[opts.currentLine] : undefined;
            if (realUrl) {
                print('on_load: redirect to ' + realUrl);
                applyPerFileOptions(opts.mpvScript);   // apply options (incl. referrer) before swapping the URL
                mpv.set('stream-open-filename', realUrl);
                redirected = true;
            } else if (opts.urls) {
                print('on_load: no url for currentLine=' + opts.currentLine + ', keep original load');
            }
            return;
        }

        // unrelated load (local file / direct URL): clear lingering state — a load failing
        // before start-file can otherwise leave hook args, pending and redirected set
        hookArgsForMainThread = undefined;
        pending = null;
        redirected = false;
    };

    function register() {
        // async callback must call next() exactly once, or this load hangs
        mpv.addHook('on_load', 10, async function (next) {
            try {
                handleOnLoad();
            } catch (e) {
                print('on_load error: ' + e);
            }
            next();
        });
        print('on_load hook registered.');
    };

    loadHookLoad = function (url, opts) {
        pending = { 'url': url, 'options': opts };
        print('loadfile: ' + url + '  (per-file options deferred to on_load)');
        mpv.command('loadfile', [url]);
    };

    loadHookDidRedirect = function () {
        return redirected;
    };

    // main thread (iina.file-loaded): attach collected audio files via audio-add.
    // Referer must go through the global `referrer` (http-header-fields sends a second
    // Referer header → bilibili CDN 403); flags use `select` (`auto` = "not selected")
    loadHookApplyPendingAudio = function () {
        if (pendingAudio.length === 0) {
            return 0;
        }
        mpv.set('referrer', pendingAudioReferrer || '');
        var urls = pendingAudio;
        pendingAudio = [];
        pendingAudioReferrer = '';
        urls.forEach(function (url) {
            print('audio-add: ' + url);
            mpv.command('audio-add', [url, 'select']);
        });
        return urls.length;
    };

    loadHookReset = function () {
        pending = null;
        redirected = false;
        hookArgsForMainThread = undefined;
        pendingAudio = [];
        pendingAudioReferrer = '';
    };

    register();
})();
