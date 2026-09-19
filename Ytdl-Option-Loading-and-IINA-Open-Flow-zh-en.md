# 流媒体参数加载（yt-dlp 方式）与 IINA 打开/解析流程
# Streaming Option Loading (the yt-dlp Way) & IINA's Open/Parse Flow

> 适用 / Applies to：IINA `develop`（本地 HEAD `f9980cb1`）、插件 `com.xjbeta.danmaku` 0.1.19
> 修订 / Revised：2026-09-11（按当前实现整体重写；旧版的"五入口 / `loadHookTakePeekedArgs` / 全局 referrer 挂轨"、
> `[flow]` 追踪日志均已作废 —— 日志统一走 `print`，仅留关键节点，见 §6.1）
> 文件名 / Filename：2026-09-11 更名自 `Load-Hook-and-Frame-Drop-zh-en.md`。内容近全量重写，
> git 提交为「删旧建新」（不保留 rename 链）。更名原因：主体已改为 yt-dlp 参数加载方式，掉帧降为附录 §8；
> 此前它还吸收过已删除的 `Frame-Drop-Monitor-root-cause-zh-en.md`（git 历史可找回）。

---

## 0. 一句话结论 / TL;DR

**中文**：IINA 自己发出的加载命令**选项位是空的**（`loadfile <url> replace -1 ""`），插件要带逐文件选项就不能再发一次 `loadfile` —— 那会打断 IINA 的"暂停 → 加载 → 恢复"配对。正确做法是 **mpv 自己的 yt-dlp 模式**：发**裸 `loadfile`**，所有参数在 mpv 的 **`on_load` 钩子**里落成 `file-local-options/*`，并在同一个钩子里换源 `stream-open-filename`。IINA 官方 ytdl 插件与 mpv 内置 `ytdl_hook.lua` 都这么做。

**English**: IINA's own load command carries an **empty options slot**, and a plugin must not simply issue a second `loadfile` (it breaks IINA's "pause → load → resume" pairing). The correct approach is **mpv's own yt-dlp pattern**: issue a **bare `loadfile`**, then apply every parameter inside the **`on_load` hook** as `file-local-options/*`, including the source switch via `stream-open-filename`. IINA's official ytdl plugin and mpv's bundled `ytdl_hook.lua` work exactly this way.

---

## 1. yt-dlp 这套参数加载方式 / The yt-dlp-style option loading

### 1.1 参数映射表 / Mapping table

yt-dlp 把一条流的所有属性塞进一个 JSON（`--dump-single-json`），播放器侧再翻译成自己的选项：

| yt-dlp 字段 / field | mpv · IINA 落点 / target | 本插件（iina-plus）来源 / our source |
|---|---|---|
| `formats[].url` / `manifest_url` | `stream-open-filename` | `urls[currentLine]` |
| `http_headers`（`Referer` / `Cookie` / `X-Forwarded-For`） | **`file-local-options/http-header-fields`（字符串数组）** | `referrer="…"` ⚠️ 见 §3 |
| `http_headers["User-Agent"]` | `file-local-options/user-agent` | `user-agent="…"` |
| `requested_formats` 中 `vcodec == "none"` 的音轨 | **`audio-add <url> select`** | `audio-file="…"` / `external-file="…"`（按族匹配，见 §5.1） |
| 标题 | `file-local-options/force-media-title` | 同 |
| 起始时间 | `file-local-options/start` | 切线路时追加 `start=<time-pos>` |
| 字幕 `requested_subtitles` | `sub-add <url> auto <title> <lang>` | （未用） |
| manifest / dash 首选码率 | `file-local-options/hls-bitrate` | `stream-lavf-o="…"` |
| rtmp 参数（`rtmp_tcurl` 等） | `file-local-options/stream-lavf-o` | 同 |
| 当前 mpv 不认的选项名（`file-local-options/<name>` 读不到） | 退回全局 `mpv.set(k, v)` | 同 |

> 官方实现的出处 / where the official implementations live
> - **mpv**：`player/lua/ytdl_hook.lua`（内置，`on_load` + `audio-add` + `file-local-options`）
> - **IINA 官方插件**：仓库 `deps/plugins/iina-plugin-ytdl-0.9.10.iinaplgz`，解包后看
>   `src/index.ts`（钩子注册，priority 10）、`src/add-video.ts` `processVideo()`（DASH 拆轨 + `audio-add`）、
>   `src/utils.ts` `setHTTPHeaders()`（Referer/Cookie → `http-header-fields` **数组**）

> **为什么这些参数必须由插件来落 / why the plugin must be the one to apply them**
> 三条理由，按重要性排序：
> 1. **换源**：iina-plus 交给 IINA 的是本地端点（`/video.mp4` → 占位 `empty.m4a`，§2.1），真实直链
>    只能由 `on_load` 里的 `stream-open-filename` 替换；URL scheme 给不了"第二次机会"。
> 2. **`referrer` 被 payload 占用**（§3）：站点 Referer 本来在白名单里、走 URL scheme 就能生效
>    （§5.1 实测），但同一个属性正被用来传 `iinaPlusArgs`。
> 3. **白名单**：IINA 对 URL scheme 里的 `mpv_*` 有白名单 `safeMPVOptions`
>    （`iina/AppDelegate.swift:1589-1644`，2026-06-18 的 `d6e4c98c` 加入）。`referrer` / `user-agent` /
>    `http-header-fields` / `cookies` / `start` / `pause` / `hls-bitrate` 在表内，而
>    `force-media-title` / `ytdl` / `stream-lavf-o` / `audio-file` / `script-opts` **不在** ⇒ 写进 URL 会被拒
>    （`mpv option … rejected when parsing URL`，`AppDelegate.swift:922-931`）。
> 另外逐文件选项要**每次加载都重来**（切清晰度/线路），URL scheme 只在打开时执行一次。
> 这就是 `DanmakuPluginOptions.mpvScript` 这个字段存在的理由。
> ⚠️ 不要试图用 `file-local-options/<name>` 走 URL scheme：白名单不含任何带 `/` 的名字，而且
> `file-local-options/*` 只在"文件正在加载/播放"的窗口内可写（§5.1 实测），URL scheme 的处理时机
> 给不出这个窗口。
> ⚠️ 裸选项名走 URL scheme **能生效**：IINA 是先 `Open URL` 再设属性（差 ~128ms），真机实测能赶上，
> 因为 mpv 必须等 `on_load` 钩子链跑完才开流 —— 而这个钩子**不依赖插件**：mpv 内嵌的 `ytdl_hook.lua`
> 在脚本加载时**无条件**注册 `on_load`（见 §5.1），IINA 也不碰 `load-scripts` / `script`，所以这 128ms
> 的窗口一直都在。URL scheme **挂不了钩子**（`mpv_*` 只能映射成 `mpv.setString`，而 `script` /
> `script-opts` / `load-scripts` 都不在白名单），但也不需要挂。

### 1.2 照抄官方的三条要点 / three things taken straight from the official pattern

1. **裸 `loadfile` + 钩子落选项**，不用 `loadfile` 的选项位；
2. **Referer 走 `file-local-options/http-header-fields`（数组）**，而不是 `referrer` 选项 —— 官方 `utils.ts` 即如此；
3. **DASH 音轨在 `on_load` 里 `audio-add`**，与换源同一次加载完成（`add-video.ts:80-98`）。

> ⚠️ 本插件在第 2、3 条上**有意偏离官方**：iina-plus 用 `referrer` 属性同时承担"传参数"职责，
> 照抄会撞车（§3）。因此我们把站点 Referer 落到 `referrer` 选项、把 `audio-add` 挪到 `iina.file-loaded`。

---

## 2. IINA 打开文件与解析流程 / IINA's open & parse flow

### 2.1 从 iina-plus 到插件拿到参数 / from iina-plus to the plugin's args

```
iina-plus
  └─ iina://open?new_window=1&url=http://127.0.0.1:19080/video.mp4?<尾部25字符>&mpv_referrer=<hex>
       └─ IINA 解析 URL scheme → mpv.set('referrer', <hex>)，并打开该端点 URL
            └─ 插件 on_load 钩子读 referrer → 解出 iinaPlusArgs（hex → JSON）
```
- iina-plus 侧生成：`IINA+/Utils/YouGetJSON.swift:197-214`（端点 URL）、`:95-118` / `:377-395`（`mpvScript`）；
- 端点恒为 `http://127.0.0.1:<port>/video.mp4?…`（`YouGetJSON.iinaPluginUrl()` 里硬编码，虎牙也一样）；
  `/video.mp4` 路由返回的是打包的 **`empty.m4a` 占位**（`HTTPHandler.swift:166-169`）⇒ **没换源就是一段空音频**，
  正好对应 §6.1 症状表里的"没换源 → 弹幕没了"。
- 虎牙的 `…/huya/<uuid>.flv` **是换源目标而不是初始 URL**：`Huya.swift:103-125` 把每个清晰度的
  `Stream.url` 都设成这个本地代理 URL，清晰度靠 `startPrewarm(uuid:)` 的会话在代理侧识别
  （`MainViewController.swift:711-717`）。所以 `endpointPattern` 只匹配 `/video.mp4` 是对的。

### 2.2 完整时序（真机 mpv.log 时间戳）/ full timeline

```
[hook] on_load            ← controller 队列，非主线程
  0.584s  读 referrer(hex) → 解析 → 写 file-local-options/*（含站点 Referer）
  0.584s  mpv.set('stream-open-filename', 真实直链)
  0.585s  [ffmpeg] Opening <真实直链>        ← 主文件 HTTP 请求，此时 Referer 已就位
  0.719s  start-file → 主线程 parseOpts → removeOpts 清空 referrer / script-opts
          → iina.plugin-overlay-loaded（×2，见 2.4）→ initDanmakuWeb → initDM
          → iina.file-loaded → audio-add 挂外挂音轨
          → mpv.end-file → deinit（插件自发重载时被吞掉）
```

> 只需记牢一条：**主文件的 HTTP 请求发生在钩子内、早于 start-file 的清理**（0.585 < 0.719）。
> §3 的全部设计都由这一条推出。

### 2.3 IINA 源码依据 / source references

| 事实 / Fact | 位置 / Location |
|---|---|
| IINA 自己的 loadfile 选项位为空 | `PlayerCore.swift:577`；日志 `options=""` |
| "暂停 → 加载 → 恢复"配对 | 暂停端 `PlayerCore.swift:558-560`；恢复端 `:2734-2756`（仅经 `notifyWindowVideoSizeChanged`，且要求 `info.state == .loaded`） |
| 钩子回调的 `next()` 约定 | `MPVController.swift:68-82`：只对**非 async** 回调代调 `next()` |
| 钩子跑在 controller 队列（非主线程） | `MPVController.swift:1112-1125`（无 `DispatchQueue.main.async`） |
| `iina.file-loaded` | 定义 `EventController.swift:46`；派发 `MPVController.swift:1150`（main.async）→ `PlayerCore.swift:2162 / 2237` |
| 插件事件回调都在主线程 | `MPVController.swift:1537-1555` |
| `mpv.start-file` / `mpv.end-file` | 即 `MPV_EVENT_START_FILE` / `MPV_EVENT_END_FILE` |

### 2.4 两条实测出来的事件行为 / two measured event behaviours

1. **`iina.plugin-overlay-loaded` 每次加载触发两次**：第一次在 `overlay.loadFile()` 之后；
   第二次由 `deinit` 里的 `overlay.simpleMode()` 引起（此刻 `iinaPlusOpts` 已清空，`initDanmakuWeb` 正常早退）。
2. **它与 `iina.file-loaded` 的先后顺序不确定**（两种顺序都实测到）⇒ 任何逻辑都不该依赖这两者的相对顺序。

---

## 3. 唯一的分歧：`referrer` 双用冲突 / the one deviation

**中文**：`referrer` 一个属性被两用，这是整条链上唯一的硬冲突：

| 角色 / Role | 谁在用 / Who |
|---|---|
| 接收通道 | iina-plus 用 `referrer` 传 iinaPlusArgs（hex） |
| 发送 Referer | 插件必须用它给主文件带站点 Referer |

由 §2.2 的时序：请求早于任何清理 ⇒ 必须在钩子里写 `referrer` ⇒ 通道必然被写脏 ⇒
解析结果只能由钩子**交接**给主线程（文件级 `hookArgsForMainThread`，**一次性消费**）。

**为什么不能照抄官方的 `http-header-fields` 来发 Referer**：两者是平行机制，
叠加会发出**两个 `Referer` 头**，B 站 CDN 对重复 Referer 直接 **403**（实测见 §5）。

三处配套防御（均在 `main.js`）：
1. 交接一次性消费 —— `parseOpts` 取走即清空；
2. 与 iina-plus 无关的加载（本地文件 / 直链）主动清空交接值，避免陈旧值被下一次 `start-file` 误用；
3. 回退读通道也安全 —— `readIinaPlusValue()` 校验取值是 hex 载荷，`consumeIinaPlusArgs()` 解析包 `try/catch`
   （否则通道被写脏时 `hexToString` 抛 `URIError`，并连带打断 `mpv.start-file` 处理器其后的 `initMenuItems()`）。

**English**: `referrer` is dual-purpose — iina-plus delivers iinaPlusArgs through it while the plugin must write the site Referer into it before the main file's request goes out (0.585s, *before* any cleanup at 0.719s). The hook therefore cannot avoid clobbering the receive channel, so the parsed result is handed to the main thread via the file-level `hookArgsForMainThread` (consumed once). Using `http-header-fields` for the Referer instead — the official pattern — is impossible here: the two mechanisms are parallel and together emit **two `Referer` headers**, which the Bilibili CDN rejects with **403**. Three safeguards back this up: one-shot consumption, proactive clearing on provably unrelated loads, and a hardened fallback read (hex validation + `try/catch`).

---

## 4. 本插件实现对应 / mapping to main.js

`main.js` 里一个自包含 IIFE 模块，对外四个入口：

| 入口 / Entry | 作用 / Purpose |
|---|---|
| `loadHookLoad(url, opts)` | 登记本次加载的逐文件选项，并发**裸 loadfile** |
| `loadHookDidRedirect()` | 初始加载是否已被钩子换成真实直链（`parseOpts` 据此决定要不要退回二次加载） |
| `loadHookApplyPendingAudio()` | 用 `audio-add <url> select` 挂外挂音轨（主线程 `iina.file-loaded` 调用） |
| `loadHookReset()` | `deinit` 时清状态 |

钩子内的两条分支：

1. **插件自己发起的加载**（`pending.url === stream-open-filename`）→ 应用登记的 `file-local-options/*`；
2. **初始加载**（URL 匹配端点 `/^https?:\/\/127\.0\.0\.1:\d+\/video\.mp4/`）→ 解析 `referrer` 里的
   `iinaPlusArgs` → 交接给主线程 → 落选项 → `stream-open-filename` 换源。

其余分支：走到末尾说明"与 iina-plus 无关"→ 清空交接值 / `pending` / `redirected`。

**钩子的两条硬约束**：
1. 回调声明为 `async` 就必须**自己调且只调一次** `next()`（IINA 只对非 async 回调代调），否则本次加载挂住；
2. 回调在 controller 队列（非主线程）⇒ 只做 mpv 读写；`overlay.loadFile` / 事件 / 菜单留给主线程 `start-file`。

---

## 5. 实测数据 / Measurements

### 5.1 mpv 语义 / mpv semantics

| 测试 / Test | 结果 / Result |
|---|---|
| `loadfile <url> replace 0 "start=2,pause=no"` | 两项都生效 |
| 选项位含无效项（`…,bogus-option=1,start=2`） | 报 "option not found"，但 `start` 仍生效 → **逐项解析，坏项不影响其他项** |
| `on_load` 里写 `file-local-options/<name>` | force-media-title / ytdl / referrer / stream-lavf-o / start / pause **全部可写** |
| `start` 在**非**钩子上下文写 | `error accessing property` → 必须写在 `on_load` 里 |
| 裸选项（全局）写在**加载前** / 写在 `on_load` 里（mpv 0.41 探针，脚本 `/tmp/hdrprobe/`） | `referrer` **两种情况都进了主文件请求头**；`force-media-title`、`start=5` 也都生效（`media-title=GLOBAL-TITLE`、`time-pos=5.0`） |
| **真机 IINA**（1.4.4 build 168 / mpv 0.38.0）：URL scheme `mpv_referrer` + `mpv_user-agent` | 日志 `12:22:54.984 Open URL` → `12:22:55.112 Setting referrer/user-agent` → **请求头里 `Referer: https://url-ref.example/` 与 `User-Agent: UA-URL` 都到了** ✅。同一条 URL 里的 `mpv_force-media-title` 被 `[w] mpv option force-media-title rejected when parsing URL` 拦掉 ❌ |
| **真机 IINA**：CLI `--mpv-referrer/--mpv-user-agent/--mpv-force-media-title`（无白名单） | `12:22:40.723 Setting mpv properties from arguments` → `12:22:40.723 Open URL` → 三个选项**全部生效**（请求头带 `Referer: https://cli-ref.example/` + `UA-CLI`） |
| ⇒ 对"先 loadfile 再传参数所以不生效"的结论 | **不成立，而且是稳的**：IINA 先 `Open URL` 后设属性（差 ~128ms），但 mpv 必须等 `on_load` 钩子链跑完才开流。**这个钩子不依赖插件** —— IINA 的 `libmpv.2.dylib` 里内嵌着 `ytdl_hook.lua` 源码，加载时**无条件**注册 `mp.add_hook("on_load", 10, …)` / `("on_load", 20, …)`（`ytdl=no` 只让回调早退，不卸载脚本；真机日志里 IINA 只设了 `ytdl=no`，没碰 `load-scripts`/`script`）⇒ 只要没显式 `--load-scripts=no`，这 128ms 的窗口永远存在 |
| URL scheme 能否挂 `on_load` 钩子？ | **不能**。`mpv_*` 只会变成 `player.mpv.setString(name, value)`（`AppDelegate.swift:920-932`），而 mpv 的钩子只能靠客户端 API（`mpv_add_hook`）或 Lua 脚本（`mp.add_hook`）注册，没有任何属性/选项能"注册钩子"；唯一绕道是让 mpv 加载 Lua（`script`），但 `script` / `script-opts` / `load-scripts` **都不在 `safeMPVOptions`**（逐项核过），白名单注释也明写要杜绝本地文件读写 |
| `file-local-options/referrer` 写在 `on_load` 里 | 同样进请求头（`Referer: https://filelocal-in-onload.example/`） |
| `file-local-options/<name>` 写在**无文件**时 | `error running command`（同一时刻写裸 `referrer` 是 `err=nil`）⇒ file-local 只能在"文件正在加载/播放"的窗口内写；IINA 的 URL scheme 处理给不出这个窗口 |
| `file-local-options/http-header-fields`（**数组**） | 可写；对主文件与**外挂音轨都生效**（官方 `setHTTPHeaders` 同款） |
| 同时给 `referrer` 与 `http-header-fields` 写 Referer | **真的发出两个 `Referer` 头** → 不能同时用 |
| `on_load` 里写 `file-local-options/audio-file`（mpv 0.38 真机） | 返回 **-3**（`MPV_ERROR_UNINITIALIZED`）→ 不可用，需走 `audio-add` |
| `on_load` 里写 `file-local-options/<name>` 的**适用范围**（mpv 0.41 CLI 探针） | 几乎**所有存在的选项**都可写：`start/end/pause/speed/volume/fullscreen/mute/ytdl/hls-bitrate/stream-lavf-o/loop-file/ab-loop-a/terminal/msg-level/vo/ao/vid/aid/script-opts/cookies/audio-files/sub-files/external-files/referrer/user-agent/http-header-fields/force-media-title/video-aspect-override` 全部成功。**唯一失败模式 = 名字在当前 mpv 里不存在**（0.41 的 `video-aspect`/`audio-file`/`sub-file`/`external-file`） |
| 读 `file-local-options/<name>` 当可写性判据（同上探针） | 12 个用例里"读得到"与"写得进"**完全一致**；`mpv_get_property_string` 对不存在的名字返回 **NULL**（`client.h:1139`「On error, NULL is returned」）→ IINA 的 `getString` 给 `undefined`。⇒ **落点不必用白名单，先读一下即可** |
| `file-local-options/<name>` 的**手册定义**（mpv 0.41 手册 · Properties） | 只有一句 "Similar to `options/<name>`, but … reset to its old value once the current file has stopped playing"，**没有任何"哪些选项是 per-file"的公开判据**；`option-info/<name>` 的子属性（`name`/`type`/`set-from-commandline`/`set-locally`/`expects-file`/`default-value`/`min`/`max`/`choices`）里也没有，且手册明说这些子属性 "may change radically in the future"。⇒ "读一下"是**唯一**可用的自动判据。手册 `on_load` 条目则**点名**可以用 `file-local-options/<option name>` 设逐文件选项 |
| `--audio-file` / `--external-file`（singular，0.41 手册） | 明确标注为 **"CLI/config file only alias"**（分别是 `--audio-files-append` / `--external-files-append` 的别名）；List Options 一节又说这类 `-append` 别名在 runtime 只能用 `change-list` 改 ⇒ **不能 assign**，这正是 0.38 真机 -3 的出处。0.41 把正名改成 `audio-files`/`sub-files`/`external-files`（0.38 是 singular）⇒ 代码按**族**（`/^(audio\|external)-file/`）匹配而非精确名字，跨版本免维护 |
| 用 `option-info/<name>/expects-file` 判"轨道族"？ | 探针（0.41）显示它对 `audio-files`/`sub-files`/`external-files` 都是 `yes`，其余是 `no`。但它是"取**文件路径**"不是"取**轨道**"，`glsl-shaders` / `cover-art-files` 这类也会是 `yes` ⇒ **不能**拿它当路由依据 |
| `audio-add <url> <flags>`（flags 同 `sub-add`） | `select` = 立即选中（默认）／**`auto` = 不选中**／`cached` = 选中并复用 → 补挂必须 `select` |
| 主文件 HTTP 请求 vs 通道清空（真机） | 0.584s 落选项 → **0.585s 请求已发出** → 0.719s 才清空 `referrer` |
| 属性变更合并 / coalescing | 背靠背两次写 = 0 个事件；间隔 30ms / 200ms = 2 个事件；同值单写 = 0 个事件 |

### 5.2 外挂音频与 CDN 的 Referer 校验 / external audio & the CDN Referer check

B 站 CDN **对重复的 `Referer` 头直接 403**。curl 打同一个音/视频 URL：

| 请求头 / Request headers | 结果 / Result |
|---|---|
| 无头 / 仅 `Referer` / 仅 `User-Agent: libmpv` | **403** |
| `User-Agent: libmpv` + **一个** `Referer` | **206** ✓ |
| **两个** `Referer`（值完全相同也一样） | **403** |

- `referrer` 选项与 `http-header-fields` 是**两套平行机制**，写 Referer 两者都有效，
  但**绝不能同时用**；主文件已用 file-local `referrer` 落站点值，挂轨前再叠一个
  `http-header-fields` 就会让外挂音轨带上两个 Referer → 403。
- 所以外挂音轨的 Referer 走**全局 `referrer`**：只是给同一个属性换值（file-local 覆盖仍在），
  因此**永远只有一个 `Referer` 头**。时机放 `iina.file-loaded`：主文件请求早已结束，不会被波及。
- **选项名关系（比"改名"更准确）**：`audio-file` / `sub-file` / `external-file` 是 `audio-files` /
  `sub-files` / `external-files` 的 **`-append` 别名**（0.41 手册：`--audio-file` = `--audio-files-append`）。
  在 **IINA 打包的 mpv 0.38 的 `libmpv.2.dylib` 里精确匹配，`audio-file`、`audio-files`、
  `audio-files-append`、`sub-file(s)`、`external-file(s)` 全都在** ⇒ 不是"0.41 才改名"，
  两个名字两版都有；区别只在**可 assign 性**：singular 走 append 语义，runtime 不能 assign
  （0.38 真机 `file-local-options/audio-file` → **-3**；0.41 直接 property not found）。
  ⇒ 要在钩子里挂外挂音轨，应该写**复数正名** `file-local-options/audio-files`（0.41 实测可写且真的挂上了，
  见 §5.1），而不是 singular；singular 只能退回 `audio-add`。
  **待验证**：0.38 上 `file-local-options/audio-files` 是否同样可写 —— 若可写，插件的
  `pendingAudio` + `audio-add` + 全局 referrer 那一套可以整体删掉（音轨与主文件同一次加载，Referer 天然一致）。

### 5.3 真机验证（会话 `2026-09-11-21-07-29`，3 个窗口 / 7 次加载）/ real-device run

| 检查项 | 结果 |
|---|---|
| `URIError` · `Failed to open` · `Can not open` | **0 / 0 / 0** |
| 每次加载 `iina plus opts (from hook)` | **7 / 7**（全部走钩子交接） |
| `initDM....` | **7 / 7** ✓ |
| 外挂音轨（6 次点播） | `audio-add` 6 次；mpv 层 `Track added` + `(+) Audio --aid=1 (*)`，音轨**已选中并在解码** |
| 唯一"无待挂"的一次 | 抖音直播（音视频复用，本就不需要挂轨）✓ |

---

## 6. 调试手册 / Debugging

- 日志目录：`~/Library/Logs/com.colliderli.iina/<session>/`（`iina.log` = IINA + 插件 `print`；`mpv.log` = mpv 详细日志）
- **多窗口会话 `mpv.log` 覆盖不全**（实测 3 窗口只记到 5 次 `Opening`、3 次 `audio-add`）
  ⇒ **以 `iina.log` 为准**（IINA 会把 mpv 的 `[stream] error:` 镜像进来）。

### 6.1 打开流程排查 / debugging the open flow

日志统一走 `print`（带 `[instanceID]` 前缀，多窗口可按实例过滤），只留关键节点：起停换源、
选项交接、外挂音轨、弹幕装载。没有 `[flow]` 链路序号了，链路靠 `on_load:` 行与
`mpv.start-file` 分隔线的相对位置判断。

```bash
grep -E 'on_load:|audio-add:|initDM|iinaPlus|parseOpts' iina.log   # 打开/挂轨/弹幕关键行
grep 'mpv.start-file\|mpv.end-file' iina.log                      # 每次加载的分隔
```

**首次打开 B站（一次加载）的健康链路**（关键 print 行；顺序即链路）：

```
plugin loaded  instance=…  mpv=…
on_load hook registered.
on_load: http://127.0.0.1:<port>/video.mp4?…                    ← 端点
on_load: redirect to https://…bilivideo.com/…m4s…              ← 换源
iina plus opts (from hook): {…}                                 ← 钩子交接（一次性消费）
remove parsed opts                                              ← 通道清空
============================mpv.start-file============================
iina.plugin-overlay-loaded
loadXMLFile.path: …                                             ← type=1 才有
initDM....
audio-add: https://…m4s…                                        ← 有外挂音轨才有
```

**PlayerCore 复用（同一窗口接着开下一个）**：

```
============================mpv.end-file============================
on_load: http://127.0.0.1:<port>/video.mp4?…                     ← 第二次端点加载
…（后续同上）
```

**异常特征速查 / symptom → log signature**：

| 现象 | 日志特征 |
|---|---|
| 弹幕没了 | 缺 `initDM....`；或整段没有 `on_load: redirect to`（没换源） |
| 弹幕张冠李戴 | `iina plus opts (from hook):` 里 rawUrl 与当前片不符（陈旧交接值被消费） |
| 音频无声 | 缺 `audio-add:`（audio-file 没收到）；或 `audio-add:` 之后 mpv.log 出现 `[stream] error: Failed to open` |
| 切清晰度丢弹幕 | 有 `loadfile: …` 但缺 `on_load: apply per-file options (plugin load)` |
| 复用后状态没清 | `deinit skipped: stopped=true (before start-file)` 之后紧接着新的 `on_load:` |
| 通道被写脏（回退读取） | `parseOpts: no iinaPlusArgs found`（脏值按"没有"处理，不抛异常） |
| iinaPlusArgs 解码失败 | `decode iinaPlusArgs failed:` / `peekIinaPlusArgs error:` |

- 离线检查 / offline checks：`node --check main.js`（仅语法）；`/tmp` 下另有 stub `iina` 运行时测试装置（按需重建）。

---

## 7. 仍未解决 / open items

| 项 | 说明 |
|---|---|
| IINA 侧 `info.currentURL` 仍是端点 URL | 换源只改 `stream-open-filename`，mpv 的 `path` 仍是 loadfile 原始参数 ⇒ now-playing / 缩略图 / 历史记的是 `127.0.0.1` 端点（与官方 Online Media 插件行为一致）。要修正只能"初始也发一次裸 loadfile"，代价是多一次加载 |
| `referrer` 双用（§3）的治本 | ~~换成 `script-opts`~~ —— **不可行**：IINA 的 URL scheme 对 `mpv_*` 有白名单 `safeMPVOptions`（`AppDelegate.swift:1589-1644`），`script-opts` 不在其中，会被直接拒（日志 `mpv option script-opts rejected when parsing URL`）。白名单里其余字符串型选项（`user-agent` / `http-header-fields` / `cookies` / `sub-font` / `geometry`…）要么是 CDN 校验在用的，要么语义会被破坏。**可行方案是换通道类型而不是换属性**：iina-plus 已经在 `dmPort` 上跑本地 HTTP（插件的 `requestNewUrl` 就在用 `/video?…&pluginAPI=1`），把 payload 改成"按 id 去本地服务器取"即可 —— 插件的 `allowedDomains` 正是 `127.0.0.1`。代价：iina-plus 侧要把 id 放进端点 URL（现在是借 referrer 的 25 字符尾巴，属循环依赖），插件侧要在钩子里 `await` 一次本地请求（`ytdl_hook` 同样会 await 外部进程，mpv 会等钩子）。收益：`referrer` 冲突、脏值防御、`hookArgsForMainThread` 一次性交接可整体删除。需改 iina-plus 侧协议，不在本仓库 |

---

## 8. 附录：掉帧（Frame Drop）历史 / Appendix: frame-drop history

**为什么会有这一节**：本文件原名含 "Frame-Drop"，吸收了已删除的掉帧文档；此处只留结论，细节见 git 历史。

**症状**：经 iina-plus 拉起在线直播时出现持续丢帧 —— `frame-drop-count` 暴涨而 `vo-drop-frame-count` 恒 0。

**机理**：IINA 省电设计会在"暂停"6 秒后停掉 `CVDisplayLink`：

| 环节 | 位置 |
|---|---|
| 状态翻转守卫 | `PlayerCore.swift:2381-2411`（守卫在 2383） |
| 武装 6s 定时器 | `PlayerCore.swift:2394` → `VideoView.swift:297-309`（`displayIdle()`，治本开关在 303） |
| 取消并重启 | `PlayerCore.swift:2396` → `VideoView.swift:277-281`（`displayActive()`） |
| 再武装点 | `MPVController.swift:1175-1176`（`playback-restart` 且 `state == .paused` → `displayIdle()`，**不看 mpv 真值**） |
| 内部开关 | `Preference.swift:1274` `enableDisplayIdle` 默认 `true`，**无任何 UI 暴露** |

链路一停，mpv 再也收不到 swap 回报（libmpv render API 的硬要求，见 `deps/include/mpv/render.h`），
于是帧全被记为"太晚到达" —— 这就是"死链"的专属指纹。

**已删除的兜底模块**：插件里原有一个 `mpv.frame-drop-count.changed` 监听 + 超阈值 `pause=true/false` 往返 +
watchdog，于 2026-09-10 删除，理由：
1. 两次真机会话的 `mpv.log` 里**都没有** `report_swap`/dropped 警告 ⇒ 链路并没有真的死；
2. 唯一一次触发（`cum=61 exceeded 60`）是直播抖动导致的**误判**，而该往返会真实产生两个属性事件
   （`playing → paused → playing`），反而扰动播放；
3. 启动本身有竞态：`fdStart()` 在 `start-file` 时 `mpvPaused === true`，只能注册 `playback-restart` 监听，
   而事件到达时该标志仍为 true ⇒ `begin()` 被跳过，监控静默休眠。

**代价**：现在插件**没有任何帧丢兜底**。若真出现死链，只能靠治本手段：

| 方案 | 彻底程度 | 代价 |
|---|---|---|
| `defaults write com.colliderli.iina enableDisplayIdle -bool false` | 让 6 秒杀链路整体失效 | 暂停时显示链路常驻（略耗电）；该 key 无 UI |
| IINA 补丁：`MPVController.swift:1175` 的 idle 判定加 `&& mpv.getFlag(MPVOption.PlaybackControl.pause)` | **最彻底** | 需维护 fork / 提 upstream PR |
