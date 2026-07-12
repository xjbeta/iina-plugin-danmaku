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
    print('remove parsed opts');
    mpv.set('referrer', '');
    mpv.set('script-opts', '');
};

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

        let mpvVer = iina.core.getVersion().mpv;
        let number = parseInt(mpvVer.match(/\.(\d+)\./)[1], 10);
        print('mpv version: ' + mpvVer);
        print('mpv number: ' + number);
        mpvNewLoadfileAPI = number >= 38;

        mpvLoadfile(opts.urls[opts.currentLine], opts.mpvScript);

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

    setObserver(true);
};

iina.event.on("iina.plugin-overlay-loaded", () => {
    print('iina.plugin-overlay-loaded');
    initDanmakuWeb();
});

iina.event.on("mpv.end-file", () => {
    print('============================mpv.end-file============================');
    if (mpvReloading) {
        mpvReloading = false;
        return;
    }
    deinit();
});

function deinit() {
    optsParsed = false;
    if (stopped) {
        return;
    };
    stopped = true;
    fdStop();
    setObserver(false);
    iinaPlusOpts = undefined;
    removeOpts();
    unloadDanmaku();
    overlayShowing = false;
    mpvPaused = false;
    danmakuWebInited = false;
};

iina.event.on("iina.pip.changed", (pip) => {
    console.log("PIP: " + pip);
});


iina.event.on("mpv.start-file", () => {
    print('============================mpv.start-file============================');
    stopped = false;
    parseOpts();
    initMenuItems();
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
// Frame Drop Monitor（治标兜底）
// IINA 活跃播放约 6s 会杀掉 CVDisplayLink 致 mpv 持续掉帧；监听 frame-drop-count，
// 累计超 250 即 pause+resume 重启链路，上限 3 次，2 分钟无触发看门狗自停。
// 启动 fdStart(mpvLoadfile) / 停止 fdStop(end-file) / 换集 running&&mpvReloading 先重启。
// 治本（不改代码）：defaults write com.colliderli.iina enableDisplayIdle -bool false
// ---------------------------------------------------------------------------
var fdStart, fdStop;
(function () {
    var running = false;
    var watchdog = null;
    var watchdogMs = 120000;
    var base = 0;
    var triggers = 0;
    var dropListenerID = null;
    var restartListenerID = null;
    var armed = false;

    function read() {
        try { return mpv.getNumber('frame-drop-count'); } catch (e) { return null; }
    }

    function onDrop(count) {
        if (triggers < 3 && (count - base) > 250) {
            triggers++;
            base = count;
            mpv.set('pause', true);
            mpv.set('pause', false);
            print('[FrameDrop] cum=' + count + ' exceeded 250, triggered pause+resume (' + triggers + '/3).');
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
        dropListenerID = iina.event.on("mpv.frame-drop-count.changed", onDrop);
        resetWatchdog();
        print('FrameDrop monitor started (>250 drops -> pause+resume, max 3, auto-stop ' + (watchdogMs / 1000) + 's)');
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
            print('[FrameDrop] no trigger within ' + (watchdogMs / 1000) + 's, stopping monitor.');
            fdStop();
        }, watchdogMs);
    }

    fdStop = function () {
        running = false;
        if (dropListenerID) { iina.event.off("mpv.frame-drop-count.changed", dropListenerID); dropListenerID = null; }
        if (restartListenerID) { iina.event.off("mpv.playback-restart", restartListenerID); restartListenerID = null; }
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        armed = false;
        print('FrameDrop monitor stopped.');
    };
})();