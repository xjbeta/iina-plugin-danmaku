$ = function(a) {
    return document.getElementById(a);
};
var defWidth = 680;
var rawUrl;
var dmType;

var cmTime = 0;

function hexToString(hex) {
    return decodeURIComponent('%' + hex.match(/.{1,2}/g).join('%'));
};

iina.onMessage("initDM", (opts) => {
    dmType = opts.type;
    defWidth = opts.dmSpeed;

    window.bind();
    window.initDM();

    switch(dmType) {
        case 0:
            rawUrl = opts.rawUrl;
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
    if (Math.abs(cmTime - t.time) > 5.5) {
        window.cm.clear();
    };
    cmTime = t.time;
    window.cm.time(Math.floor(t.time * 1000));
});
iina.onMessage("pauseChanged", (t) => {
    t.isPaused ? window.cm.stop() : window.cm.start();
});
iina.onMessage("close", () => {
    cm.clear;
    cm.stop;
});

function bind() {
    window.cm = new CommentManager($('commentCanvas'));
    cm.init();
    window.cmResize = function () {
        var scale = $("player").offsetWidth / defWidth;
        window.cm.options.scroll.scale = scale;
        cm.setBounds();
    };

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState == 'visible') {
            console.log('visible');
            cm.start();
            cm.clear();
        } else {
            console.log('hidden');
            cm.stop();
            cm.clear();
        };
    });

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

function blockDmType(t) {
    // if (t.includes('List')) {
    //     window.loadFilter('/danmaku/iina-plus-blockList.xml');
    // }
   
    cm.filter.allowTypes[5] = !t.includes('Top');
    cm.filter.allowTypes[4] = !t.includes('Bottom');
    cm.filter.allowTypes[1] = !t.includes('Scroll');
    cm.filter.allowTypes[2] = !t.includes('Scroll');

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

    cm.filter.allowTypes[7] = !t.includes('Advanced');
    cm.filter.allowTypes[8] = !t.includes('Advanced');
};

function start(websocketServerLocation){
    ws = new WebSocket(websocketServerLocation);
    updateStatus('warning');
    ws.onopen = function(evt) { 
        updateStatus();
        ws.send('iinaDM://' + rawUrl);
    };
    ws.onmessage = function(evt) { 
        var event = JSON.parse(evt.data);
        
        if (event.method != 'sendDM') {
            console.log(event.method, event.text);
        }
        
        switch(event.method) {
        case 'sendDM':
            if (document.visibilityState == 'visible') {
                var comment = {
                    'text': event.text,
                    'stime': 0,
                    'mode': 1,
                    'color': 0xffffff,
                    'border': false
                };
                window.cm.send(comment);
            }
            break
        default:
            break;
        }

    };
    ws.onclose = function(){
        if (dmType == 0) {
            updateStatus('warning');
            // Try to reconnect in 1 seconds
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
