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
    mpv.set('script-opts', '');
};

function parseOpts() {
    if (optsParsed || mpv.getString('path') != "-") {
        return;
    };

    let scriptOpts = mpv.getString('script-opts').split(',');
    let iinaPlusValue = scriptOpts.find(s => s.startsWith(iinaPlusArgsKey));
    
    optsParsed = true;
    removeOpts();

    if (iinaPlusValue && !stopped) {

        let opts = JSON.parse(hexToString(iinaPlusValue.substring(iinaPlusArgsKey.length)));
        print('iina plus opts: ' + JSON.stringify(opts));

        if (parseFloat(iina.core.getVersion().mpv.replace(/^.*v0\./, '')) >= 38) {
            // v0.38.0
            mpv.command('loadfile', [opts.urls[opts.currentLine], 'replace', '0', opts.mpvScript]);
        } else {
            mpv.command('loadfile', [opts.urls[opts.currentLine], 'replace', opts.mpvScript]);
        };

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

        initMenuItems();
    };
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

        mpv.command('loadfile', [url, 'replace', re.mpvScript]);
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


    print('initDM.');
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

iina.event.on("iina.window-will-close", () => {
    print('iina.window-will-close');
    deinit();
});

iina.event.on("iina.window-did-close", () => {
    print('iina.window-did-close');
    deinit();
});

function deinit() {
    if (stopped) {
        return;
    };
    stopped = true;
    setObserver(false);
    iinaPlusOpts = undefined;
    optsParsed = false;
    removeOpts();
    unloadDanmaku();
    overlayShowing = false;
    mpvPaused = false;
    danmakuWebInited = false;
};

iina.event.on("iina.pip.changed", (pip) => {
    console.log("PIP: " + pip);
});


iina.event.on("iina.file-started", () => {
    print('iina.file-started');
    stopped = false;
    let e = iina.preferences.get('enableIINAPLUSOptsParse');
    let p = mpv.getString('path');
    if (p == "-") {
        parseOpts();
        return;
    }
    print('Ignore IINA+ Opts Parse, ' + p);
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