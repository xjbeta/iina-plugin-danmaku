// Danmaku overlay (WKWebView) — bridges the IINA plugin and CommentCoreLibrary.

const _ = import('../node_modules/comment-core-library');

// ---- Globals & Helpers ----

$ = function(a) {
    return document.getElementById(a);
};

var baseWidth = 680;
var liveUrl;
var srcType;
var lastTime = 0;

function hexToString(hex) {
    return decodeURIComponent('%' + hex.match(/.{1,2}/g).join('%'));
};

// ---- Danmaku play/visibility state ----
//
// Two independent truths decide whether danmaku should render:
//   wantPlaying — false while the video is paused (user intent)
//   hidden      — true while the window is occluded / in the background
// Rendering only happens when the video plays AND the window is visible.
//
// `hidden` is OR-merged from two sources that disagree during transitions:
// the IINA side (NSWindow.occlusionState) and the webview's own visibility
// API. OR semantics are deliberate — a stale "visible" from one source must
// never resume rendering while the other still reports hidden.

var wantPlaying = true;
var hiddenByIINA = false;
var hiddenByWebview = false;

// Pending WebSocket danmaku timers. A burst of dms is staggered with
// setTimeout(index * 150) to smooth output — but those timers keep ticking
// while hidden, so on restore they would all fire at once and dump a pile of
// stale danmaku onto the screen. We drop them whenever rendering stops.
var dmTimers = [];

function clearDmTimers() {
    for (var i = 0; i < dmTimers.length; i++) {
        clearTimeout(dmTimers[i]);
    }
    dmTimers = [];
}

// Last (hidden, wantPlaying) combination pushed to cm. The IINA side
// re-reports window state on every poll tick, so dedupe here rather than
// doing needless clear()/start() work twice a second.
var lastAppliedState = null;

// Reconcile cm with (wantPlaying, hidden):
//   hidden          — drop everything, nothing should linger on screen
//   visible, paused — keep on-screen danmaku frozen (normal pause look)
//   visible, playing— render
// Pending timers are dropped in both non-rendering cases, since they would
// otherwise all fire at once the moment rendering resumes.
function applyDanmakuState() {
    if (typeof window.cm === 'undefined' || !window.cm.setHidden) {
        return;
    }
    var hidden = hiddenByIINA || hiddenByWebview;
    var state = (hidden ? 'H' : 'V') + (wantPlaying ? 'P' : 'S');
    if (state === lastAppliedState) {
        return;
    }
    lastAppliedState = state;
    if (window.cm.isHidden() !== hidden) {
        window.cm.setHidden(hidden);
    }
    if (hidden) {
        window.cm.clear();
        clearDmTimers();
        window.cm.stop();
    } else if (wantPlaying) {
        window.cm.start();
    } else {
        clearDmTimers();
        window.cm.stop();
    }
}

// ---- iina Message Handlers ----

iina.onMessage("initDM", (opts) => {
    srcType = opts.type;
    baseWidth = opts.dmSpeed;

    // Fresh file — drop leftover timers, reset per-file intent, and force a
    // re-apply since a new cm was just created. Visibility is tracked
    // per-window rather than per-file, so hiddenByIINA keeps its value (the
    // IINA side also re-reports it right after initDM to be safe).
    clearDmTimers();
    wantPlaying = true;
    hiddenByWebview = document.hidden;
    lastAppliedState = null;

    window.bind();
    window.initDM();
    applyDanmakuState();

    switch(srcType) {
        case 0:
            liveUrl = opts.rawUrl;
            initWebsocket(opts.port);
            break;
        case 1:
            window.loadDM(hexToString(opts.xmlContent), 'iina-danmaku');
            break;
        default:
            return;
    };

    // Block unknown types.
    // https://github.com/jabbany/CommentCoreLibrary/issues/97
    window.cm.filter.allowUnknownTypes = false;
    window.cm.options.global.opacity = opts.dmOpacity;

    blockDmType(opts.blockType);

    let newCSS = ".customFont {color: #fff;font-family: '"+ opts.dmFont +"',SimHei,SimSun,monospace;font-size: 24px;letter-spacing: 0;line-height: 100%;margin: 0;padding: 3px 0 0 0;position: absolute;text-decoration: none;text-shadow: -1px 0 black, 0 1px black, 1px 0 black, 0 -1px black;-webkit-text-size-adjust: none;-ms-text-size-adjust: none;text-size-adjust: none;-webkit-transform: matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);transform: matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);-webkit-transform-origin: 0% 0%;-ms-transform-origin: 0% 0%;transform-origin: 0% 0%;white-space: pre;word-break: keep-all;}}"
    window.customFont(newCSS);

    setTimeout(function () {
        window.cmResize();
    }, 1000);
});

iina.onMessage("resizeWindow", () => {
    window.cmResize();
});

iina.onMessage("sendDM", (t) => {
    var comment = {
        'text': t.text,
        'stime': 0,
        'mode': 1,
        'color': 0xffffff,
        'border': false
    };
    window.cm.send(comment);
});

iina.onMessage("timeChanged", (t) => {
    if (Math.abs(lastTime - t.time) > 5.5) {
        window.cm.clear();
    };
    lastTime = t.time;
    window.cm.time(Math.floor(t.time * 1000));
});

iina.onMessage("pauseChanged", (t) => {
    wantPlaying = !t.isPaused;
    applyDanmakuState();
});

iina.onMessage("setHidden", (t) => {
    var changed = hiddenByIINA !== t.hidden;
    hiddenByIINA = t.hidden;
    if (!t.hidden) {
        // The IINA side says the window is visible (authoritative, from
        // occlusionState). Drop our own flag too — the webview's
        // visibilitychange can fire in one direction only and latch us hidden.
        hiddenByWebview = false;
    }
    applyDanmakuState();
    if (changed) {
        console.log('setHidden:', t.hidden);
    }
});

iina.onMessage("close", () => {
    clearDmTimers();
    window.cm.clear();
    window.cm.stop();
    window._provider.destroy();
    ws.onclose = function(){};
    ws.close();
    liveUrl = undefined;
    srcType = undefined;
    updateStatus('');
});

// ---- CommentManager Setup ----

function bind() {
    window.cm = new CommentManager($('commentCanvas'));
    cm.init();
    window.cmResize = function () {
        var scale = $("player").offsetWidth / baseWidth;
        window.cm.options.scroll.scale = scale;
        cm.setBounds();
    };

    window.initDM = function() {
        if (window._provider && window._provider instanceof CommentProvider) {
            window._provider.destroy();
        }
        window._provider = new CommentProvider();
        cm.clear();
        window._provider.addTarget(cm);
        cmResize();
        cm.init();
        cm.start();
    };

    window.customFont = function(fontStyle) {
        var element = document.getElementsByTagName("style"), index;
        for (index = element.length - 1; index >= 0; index--) {
        element[index].parentNode.removeChild(element[index]);
        }

        var style = document.createElement('style');
        style.type = 'text/css';
        style.innerHTML = fontStyle;
        document.getElementsByTagName('head')[0].appendChild(style);
        window.cm.options.global.className = 'customFont'
    };

    /** Load **/
    window.loadDM = function(dmf, provider) {
        if (window._provider && window._provider instanceof CommentProvider) {
            window._provider.destroy();
        }
        window._provider = new CommentProvider();
        cm.clear();
        window._provider.addTarget(cm);
        cmResize();
        switch (provider) {
            case "acfun":
                window._provider.addStaticSource(
                    CommentProvider.JSONProvider('GET', dmf),
                    CommentProvider.SOURCE_JSON).addParser(
                    new AcfunFormat.JSONParser(),
                    CommentProvider.SOURCE_JSON);
                break;
            case "cdf":
                window._provider.addStaticSource(
                    CommentProvider.JSONProvider('GET', dmf),
                    CommentProvider.SOURCE_JSON).addParser(
                    new CommonDanmakuFormat.JSONParser(),
                    CommentProvider.SOURCE_JSON);
                break;
            case "bilibili-text":
                window._provider.addStaticSource(
                    CommentProvider.TextProvider('GET', dmf),
                    CommentProvider.SOURCE_TEXT).addParser(
                    new BilibiliFormat.TextParser(),
                    CommentProvider.SOURCE_TEXT);
                break;
            case "iina-danmaku":
                window._provider.addStaticSource(
                    Promise.resolve(dmf),
                    CommentProvider.SOURCE_TEXT).addParser(
                    new BilibiliFormat.TextParser(),
                    CommentProvider.SOURCE_TEXT);
                break;
            case "bilibili":
            default:
                window._provider.addStaticSource(
                    CommentProvider.XMLProvider('GET', dmf),
                    CommentProvider.SOURCE_XML).addParser(
                    new BilibiliFormat.XMLParser(),
                    CommentProvider.SOURCE_XML);
                break;
        }
        window._provider.start().then(function() {
            cm.start();
        }).catch(function(e) {
            alert(e);
        });
    };

    window.loadFilter = function(ff) {
        cm.filter.rules = [];
        CommentProvider.XMLProvider("GET", ff)
        .then(result => result.getElementsByTagName("item"))
        .then(items => [...items].map(r => r.textContent).filter(r => r.startsWith('r=')).map(r => r.replace('r=', '')))
        .then(function(values) {
            values.forEach(v =>
                cm.filter.addRule({
                    "subject": "text",
                    "op": "~",
                    "value": v,
                    "mode": "reject"
                })
            )
        });
    };
};

// ---- Status Indicator ----

function updateStatus(status){
    switch(status) {
    case 'warning':
        document.getElementById("status").style.backgroundColor="#FFB742"
        break
    case 'error':
        document.getElementById("status").style.backgroundColor="#FF2640"
        break
    default:
        document.getElementById("status").style.backgroundColor=""
        break
    }
}

// ---- Type Blocking ----

function blockDmType(t) {
    // CCL mode: 1/2/6 scroll, 5 top, 4 bottom, 7/8 advanced
    cm.filter.allowTypes[1] = !t.includes('Scroll');
    cm.filter.allowTypes[2] = !t.includes('Scroll');
    cm.filter.allowTypes[6] = !t.includes('Scroll');
    cm.filter.allowTypes[5] = !t.includes('Top');
    cm.filter.allowTypes[4] = !t.includes('Bottom');
    cm.filter.allowTypes[7] = !t.includes('Advanced');
    cm.filter.allowTypes[8] = !t.includes('Advanced');

    // block color -> keep only white
    let colorRule = {
        subject: 'color',
        op: '=',
        value: 16777215,
        mode: 'accept'
    };

    if (t.includes('Color')) {
        cm.filter.addRule(colorRule);
    } else {
        cm.filter.removeRule(colorRule);
    };
};

// ---- WebSocket (live danmaku) ----

function start(websocketServerLocation){
    ws = new WebSocket(websocketServerLocation);
    updateStatus('warning');
    ws.onopen = function(evt) {
        updateStatus();
        ws.send('iinaDM://' + 'v=1&' + liveUrl);
    };
    ws.onmessage = function(evt) {
        var event = JSON.parse(evt.data);

        if (event.method != 'sendDM') {
            console.log(event.method, event.text);
        }

        switch(event.method) {
        case 'sendDM':
            event.dms.forEach(function(element, index) {
                dmTimers.push(setTimeout(function () {
                    var comment = {
                        'text': element.text,
                        'stime': 0,
                        'mode': 1,
                        'color': 0xffffff,
                        'border': false,
                        'imageSrc': element.imageSrc,
                        'imageWidth': element.imageWidth
                    };
                    window.cm.send(comment);
                }, index * 150));
            });
        default:
            break;
        }

    };
    ws.onclose = function(){
        if (srcType == 0) {
            updateStatus('warning');
            // Reconnect after 1.5s
            setTimeout(function(){start(websocketServerLocation)}, 1500);
        }
    };
}

// function sendDebugCM(text) {
//     var comment = {
//         'text': text,
//         'stime': 0,
//         'mode': 1,
//         'align': 2,
//         'color': 0xffffff,
//         'border': false
//     };
//     window.cm.send(comment);
// };

function initWebsocket(port){
    if (port === undefined){
        port = 19080;
    }
    start('ws://127.0.0.1:' + port + '/danmaku-websocket');
    console.log('initWebsocket');
}

// Visibility — WKWebView's own signal (fast path for occlusion/changes).
// IINA side's window-main.changed provides the cross-check via occlusionState.

document.addEventListener("visibilitychange", () => {
    hiddenByWebview = document.hidden;
    applyDanmakuState();
    console.log('visibilitychange: hidden=' + document.hidden);
});
