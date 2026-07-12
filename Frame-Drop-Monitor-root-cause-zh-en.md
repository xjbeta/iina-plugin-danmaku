# IINA 持续掉帧根因分析（中英对照）
# IINA Continuous Frame Drop — Root Cause Analysis (Bilingual)

> 适用版本 / Applies to: IINA `release/1.4.3` (HEAD `c111221e`), macOS, mpv `vo=libmpv`
> 分析日期 / Date: 2026-07-12
> 关联插件 / Related plugin: `iina-plugin-danmaku` (`main.js` 中的 Frame Drop Monitor 为治标兜底)

---

## 0. 一句话结论 / One-Line Conclusion

**中文**：IINA 有一个"播放暂停 6 秒后停掉显示链路以省电"的节能设计。在你的场景里，IINA 的内部播放状态被错误地钉死在 `.paused`，于是这个 6 秒定时器被反复武装 → 到点调用 `stopDisplayLink()` 杀掉 `CVDisplayLink` → mpv 每帧的 `report_swap` 回报永远不再发生 → mpv 的 libmpv 渲染层认定"帧从未被呈现" → 持续丢帧。

**English**: IINA has an energy-saving design that "stops the display link 6 seconds after playback is paused." In this scenario IINA's internal playback state is wrongly pinned to `.paused`, so the 6-second timer is repeatedly armed → when it fires it calls `stopDisplayLink()` and kills the `CVDisplayLink` → mpv's per-frame `report_swap` is never reported again → mpv's libmpv render layer decides "frames were never presented" → continuous frame drops.

---

## 1. 显示链路 `CVDisplayLink` 是什么，为什么关键 / What `CVDisplayLink` Is and Why It Matters

**中文**：`CVDisplayLink` 是 macOS 上一个以显示器刷新率运行的高优先级线程，每个 vsync 触发一次回调。

- `startDisplayLink()`（VideoView.swift:227-235）创建并启动它，把 `displayLinkCallback` 注册为输出回调（231 行）。
- `displayLinkCallback`（VideoView.swift:542-554）每个 vsync 调一次，关键在 **551 行**：
  ```swift
  videoView.player.mpv.mpvReportSwap()
  ```
- 也就是说：**只要链路在跑，mpv 每个呈现帧都会被 IINA 回报一次 swap。**

`stopDisplayLink()`（237-241）则 `CVDisplayLinkStop` 把它停掉。一旦停掉，`displayLinkCallback` 不再触发，`mpvReportSwap()` 就再也不会被调用。

**English**: `CVDisplayLink` is a high-priority macOS thread running at the display refresh rate; it fires a callback on every vsync.

- `startDisplayLink()` (VideoView.swift:227-235) creates and starts it, registering `displayLinkCallback` as the output callback (line 231).
- `displayLinkCallback` (VideoView.swift:542-554) runs once per vsync; the key line is **551**:
  ```swift
  videoView.player.mpv.mpvReportSwap()
  ```
- In other words: **as long as the link runs, every presented frame is reported back to mpv via swap.**

`stopDisplayLink()` (237-241) calls `CVDisplayLinkStop` to halt it. Once stopped, `displayLinkCallback` no longer fires and `mpvReportSwap()` is never called again.

---

## 2. mpv 的 Render API 要求宿主回报 swap / mpv's Render API Requires the Host to Report Swap

**中文**：`mpvReportSwap()`（MPVController.swift:737-740）只有一行实质内容：

```swift
mpv_render_context_report_swap(mpvRenderContext)
```

这是 mpv **libmpv 渲染 API** 的硬性要求：`vo=libmpv` 模式下，宿主（IINA）在把 mpv 给的帧真正呈现到屏幕后，必须调用 `mpv_render_context_report_swap()`，相当于告诉 mpv"这一帧你已经看到了"。

如果这个函数长期不被调用，mpv 的渲染/帧同步逻辑会认为"我给你的帧一直没被显示"，于是按"帧来得太晚/无法呈现"处理 → 直接丢弃。这就是 `frame-drop-count` 暴涨的来源。

**English**: `mpvReportSwap()` (MPVController.swift:737-740) contains essentially one line:

```swift
mpv_render_context_report_swap(mpvRenderContext)
```

This is a hard requirement of mpv's **libmpv render API**: in `vo=libmpv` mode the host (IINA) must call `mpv_render_context_report_swap()` after actually presenting the frame mpv gave it — i.e. telling mpv "you have now seen this frame."

If this function is not called for a long time, mpv's render/frame-sync logic concludes "the frames I produced were never displayed" and treats them as "too late / not presentable" → drops them outright. This is the source of the exploding `frame-drop-count`.

---

## 3. IINA 的节能设计：暂停 6 秒后杀链路 / IINA's Energy-Saving Design: Kill the Link After 6s Idle

**中文**：`displayIdle()`（VideoView.swift:299-312）是杀链路的唯一入口：

```swift
func displayIdle() {
  displayIdleTimer?.invalidate()
  return                                   // ← 本地未提交的调试补丁，当前让本函数直接返回
  guard Preference.bool(for: .enableDisplayIdle) else { return }   // 306 行：治本开关
  displayIdleTimer = Timer(timeInterval: 6.0, target: self,
                           selector: #selector(stopDisplayLink), ...)   // 310 行：6 秒
  RunLoop.current.add(displayIdleTimer!, forMode: .default)
}
```

逻辑：调用 `displayIdle()` 时，**武装一个 6 秒的一次性定时器**，6 秒后触发 `stopDisplayLink()`。

与之相对的是 `displayActive()`（280-283）：

```swift
func displayActive() {
  displayIdleTimer?.invalidate()   // 取消待发的杀链路定时器
  startDisplayLink()               // 重新拉起链路
}
```

所以"杀"和"救"都集中在这对函数上：谁调 `displayIdle()` 谁就武装定时器，谁调 `displayActive()` 谁就取消定时器并重启链路。

**English**: `displayIdle()` (VideoView.swift:299-312) is the only entry point that kills the link:

```swift
func displayIdle() {
  displayIdleTimer?.invalidate()
  return                                   // ← local uncommitted debug patch, currently returns early
  guard Preference.bool(for: .enableDisplayIdle) else { return }   // line 306: root-cause fix switch
  displayIdleTimer = Timer(timeInterval: 6.0, target: self,
                           selector: #selector(stopDisplayLink), ...)   // line 310: 6 seconds
  RunLoop.current.add(displayIdleTimer!, forMode: .default)
}
```

Behavior: calling `displayIdle()` **arms a one-shot 6-second timer** that fires `stopDisplayLink()` after 6 seconds.

The counterpart is `displayActive()` (280-283):

```swift
func displayActive() {
  displayIdleTimer?.invalidate()   // cancel the pending kill timer
  startDisplayLink()               // restart the link
}
```

So "kill" and "rescue" are both centralized in this pair: whoever calls `displayIdle()` arms the timer; whoever calls `displayActive()` cancels it and restarts the link.

---

## 4. 谁会调用 `displayIdle()`（武装定时器）/ Who Calls `displayIdle()` (Arms the Timer)

**中文**：三处会武装定时器，且都基于"IINA 认为播放已暂停"：

1. **`pauseChanged`**（PlayerCore.swift:2276-2293）—— 主路径：
   ```swift
   if paused {
     mainWindow.videoView.displayIdle()      // 2289：状态变暂停 → 武装
   } else {
     mainWindow.videoView.displayActive()     // 2291：状态变播放 → 取消+重启
   }
   ```
   注意 2278 行的**转换守卫** `if (info.state == .paused) != paused`：只有"内部状态和 mpv 报告的 paused 不一致"时才动作。

2. **`MPV_EVENT_PLAYBACK_RESTART`**（MPVController.swift:1161-1169）：
   ```swift
   if player.info.state == .paused {
     player.mainWindow.videoView.displayIdle()   // 1168：起播时若状态是暂停 → 再次武装
   }
   ```
   这是关键的"再武装"点：只要 `info.state` 仍是 `.paused`，每次起播都会重新武装 6 秒定时器。

3. `MainWindowController` 的若干处（1423、1572 行）也会调 `displayIdle()`。

**English**: Three places arm the timer, all based on "IINA believes playback is paused":

1. **`pauseChanged`** (PlayerCore.swift:2276-2293) — the main path:
   ```swift
   if paused {
     mainWindow.videoView.displayIdle()      // 2289: state became paused → arm
   } else {
     mainWindow.videoView.displayActive()     // 2291: state became playing → cancel + restart
   }
   ```
   Note the **transition guard** at line 2278, `if (info.state == .paused) != paused`: it only acts when "the internal state and the `paused` reported by mpv disagree."

2. **`MPV_EVENT_PLAYBACK_RESTART`** (MPVController.swift:1161-1169):
   ```swift
   if player.info.state == .paused {
     player.mainWindow.videoView.displayIdle()   // 1168: if still paused at (re)start → arm again
   }
   ```
   This is the critical "re-arm" point: as long as `info.state` is `.paused`, every (re)start re-arms the 6-second timer.

3. Several spots in `MainWindowController` (lines 1423, 1572) also call `displayIdle()`.

---

## 5. 核心 bug：内部状态被钉死在 `.paused` / Core Bug: Internal State Pinned to `.paused`

**中文**：正常流程里，mpv 暂停会发 `pause=true`、恢复会发 `pause=false`，IINA 的状态在 `.paused`/`.playing` 间正常切换，定时器该武装时武装、该取消时取消。

但在你的场景（弹幕插件 `loadfile replace` 起播）下：

- `loadfile` 过程中，mpv 会**瞬时发出一个 `pause=true`**（这是 mpv 在替换文件时的过渡态）。
- IINA 的 `pauseChanged(true)` 收到后，因 `info.state(.playing) != true`，命中转换守卫 → 把 `info.state` 置为 `.paused`，并调用 `displayIdle()` **武装 6 秒定时器**。
- 但**对应的 `pause=false` 没有作为属性变更事件送达 IINA**（mpv 在 loadfile 内部清掉了内部 pause 标志，却没有走 IINA 监听的那条 property-change 通知，或通知在 loadfile 竞态里被吞掉）。
- 于是 `info.state` **永远停在 `.paused`**，而 mpv 实际上在解码、在播放。

这形成了死锁：

- 因为 `info.state == .paused`，每次 `playback-restart`（第 1168 行）都会再次 `displayIdle()` → **定时器不断被重新武装**；
- 因为状态不再发生"≠"的转换，`pauseChanged` 的 `else` 分支（2291 行 `displayActive()`）**永远不会被调用** → 定时器永远不被取消。

**English**: In the normal flow, mpv emits `pause=true` when pausing and `pause=false` when resuming, so IINA's state toggles between `.paused`/`.playing` normally, arming and cancelling the timer as appropriate.

But in this scenario (danmaku plugin `loadfile replace` startup):

- During `loadfile`, mpv **transiently emits a `pause=true`** (a transitional state while replacing the file).
- IINA's `pauseChanged(true)` receives it; because `info.state(.playing) != true`, it hits the transition guard → sets `info.state` to `.paused` and calls `displayIdle()` **arming the 6-second timer**.
- But the **paired `pause=false` is never delivered to IINA as a property-change event** (mpv clears its internal pause flag internally during loadfile without going through the property-change notification IINA listens to, or the notification is swallowed in the loadfile race).
- Thus `info.state` **stays at `.paused` forever**, while mpv is actually decoding and playing.

This creates a deadlock:

- Because `info.state == .paused`, every `playback-restart` (line 1168) calls `displayIdle()` again → **the timer keeps being re-armed**;
- Because the state never transitions to "≠", the `else` branch of `pauseChanged` (line 2291 `displayActive()`) **is never called** → the timer is never cancelled.

---

## 6. 完整因果链（时间线）/ Full Causal Chain (Timeline)

**中文**：

```
t=0     插件 loadfile replace 起播；mpv 进入播放
t≈0     mpv 瞬时 pause=true → IINA pauseChanged(true) → info.state=.paused + displayIdle() 武装 6s 定时器
t≈0~6s  mpv 实际在解码播放，但 IINA 以为暂停；displayLinkCallback 仍在跑（还没到 6s）
t=6s    定时器触发 stopDisplayLink() → CVDisplayLink 停止
t>6s    displayLinkCallback 不再触发 → mpvReportSwap() 永远不被调用
        → mpv 认为帧从未呈现 → frame-drop-count 持续暴涨、vo-drop-frame-count 恒 0
        → 每 ~6s（下一次 playback-restart 若仍 .paused）定时器又被武装一次，链路持续处于"死"态
```

**English**:

```
t=0     plugin loadfile replace starts playback; mpv begins playing
t≈0     mpv transient pause=true → IINA pauseChanged(true) → info.state=.paused + displayIdle() arms 6s timer
t≈0~6s  mpv is actually decoding/playing, but IINA thinks it's paused; displayLinkCallback still runs (under 6s)
t=6s    timer fires stopDisplayLink() → CVDisplayLink stops
t>6s    displayLinkCallback no longer fires → mpvReportSwap() is never called
        → mpv thinks frames were never presented → frame-drop-count keeps exploding, vo-drop-frame-count stays 0
        → every ~6s (next playback-restart if still .paused) the timer is re-armed; link stays "dead"
```

---

## 7. 为什么手动"暂停→继续"能临时救，却每 6 秒复发 / Why Manual Pause→Resume Temporarily Fixes but Recurs Every 6s

**中文**：

- **救**：手动 `resume()`（PlayerCore.swift:883-885）在设 `pause=false` **之前**先调 `displayActive()`（885 行）→ 取消定时器 + `startDisplayLink()` → 链路重启，`mpvReportSwap()` 恢复。插件里那对 `mpv.set('pause', true/false)` 走的也是同一条 `pauseChanged` 路径（`pause=false` 那次命中转换守卫，翻回 `.playing` 并 `displayActive()`）。
- **复发**：一旦 `info.state` 又被某个 `playback-restart` 判定为 `.paused`（只要它还没被彻底翻回 `.playing`，或在下一个 loadfile 又吃到一个瞬时 `pause=true`），第 1168 行就会再次 `displayIdle()` 武装定时器 → 6 秒后链路再死。所以不治本时，它会是"救活 ~6 秒 → 又死"的循环。

**English**:

- **Fix**: manual `resume()` (PlayerCore.swift:883-885) calls `displayActive()` (line 885) **before** setting `pause=false` → cancels the timer + `startDisplayLink()` → link restarts, `mpvReportSwap()` resumes. The plugin's `mpv.set('pause', true/false)` pair travels the same `pauseChanged` path (the `pause=false` event hits the transition guard, flips back to `.playing` and calls `displayActive()`).
- **Recurrence**: once `info.state` is again judged `.paused` by some `playback-restart` (as long as it hasn't been fully flipped back to `.playing`, or the next loadfile ingests another transient `pause=true`), line 1168 calls `displayIdle()` again and re-arms the timer → the link dies again 6 seconds later. So without the root fix it is a "revive ~6s → die again" loop.

---

## 8. 为什么 `defaults write ... enableDisplayIdle -bool false` 能根治 / Why `defaults write ... enableDisplayIdle -bool false` Is the Root Fix

**中文**：看 VideoView.swift:306 的守护：

```swift
guard Preference.bool(for: .enableDisplayIdle) else { return }
```

`enableDisplayIdle` 默认值 `true`（Preference.swift:348 定义、1027 默认 true）。设成 `false` 后，**`displayIdle()` 在创建定时器之前就直接返回**——定时器永远不被武装，`stopDisplayLink()` 经由这条省电路径永远不被调用，`CVDisplayLink` 始终运行，`mpvReportSwap()` 持续回报，丢帧消失。

> 旁注：你本地的 `VideoView.swift` 第 304 行有一个**未提交的裸 `return`**（你自己的 Xcode 调试补丁），效果等同于把 `displayIdle()` 整体短路——所以你本地编译版其实也绕开了这条路。但那是源码改动，不是给用户的分发方案；对普通用户，`defaults write` 才是唯一不改代码的治本方式。

**English**: See the guard at VideoView.swift:306:

```swift
guard Preference.bool(for: .enableDisplayIdle) else { return }
```

`enableDisplayIdle` defaults to `true` (defined at Preference.swift:348, default `true` at 1027). Once set to `false`, **`displayIdle()` returns before it ever creates the timer** — the timer is never armed, `stopDisplayLink()` is never reached via this energy-saving path, `CVDisplayLink` keeps running, `mpvReportSwap()` keeps being reported, and the frame drops disappear.

> Side note: your local `VideoView.swift` has an **uncommitted bare `return` at line 304** (your own Xcode debug patch) that short-circuits `displayIdle()` entirely — so your locally built copy also bypasses this path. But that is a source change, not a distributable fix; for ordinary users, `defaults write` is the only root fix that touches no code.

---

## 9. 诊断指纹：为什么 `frame-drop-count` 涨而 `vo-drop-frame-count` 恒 0 / Diagnostic Fingerprint: Why `frame-drop-count` Rises but `vo-drop-frame-count` Stays 0

**中文**：这是定位到"死链"而非"性能不足"的决定性证据：

- `frame-drop-count` 是 mpv **核心层**"因来得太晚而丢弃的帧总数"。链路死后 mpv 仍在产出帧，但 swap 没回报，核心层把这些帧全记为丢弃 → **暴涨**。
- `vo-drop-frame-count` 是**视频输出（vo）层**自己的丢帧计数。链路死在上游（渲染/呈现握手层），vo 根本没机会拿到帧去呈现，所以它的计数器**恒为 0**。
- 对比真实性能不足：那种情况 vo 层会真的在丢帧，`vo-drop-frame-count` 也会涨。两者背离（核心涨、vo 恒 0）正是"宿主没回报 swap"的专属指纹，与 mpv 日志里 `mpv_render_report_swap() not being called` 完全吻合。

**English**: This is the decisive evidence that pins it to "dead link" rather than "insufficient performance":

- `frame-drop-count` is the mpv **core layer**'s total of frames "dropped because they arrived too late." After the link dies, mpv still produces frames but no swap is reported, so the core counts them all as dropped → **explodes**.
- `vo-drop-frame-count` is the **video-output (vo) layer**'s own drop counter. The link dies upstream (at the render/presentation handshake), so the vo never even gets a chance to present frames, and its counter **stays at 0**.
- Contrast with genuine performance shortage: there the vo layer really is dropping frames and `vo-drop-frame-count` would also rise. The divergence (core up, vo at 0) is the signature exclusively of "host not reporting swap," matching mpv's log line `mpv_render_report_swap() not being called`.

---

## 10. 代码位置速查表 / Code Location Reference

| 角色 / Role | 文件:行 / File:Line | 说明 / Description |
|---|---|---|
| 每帧回报 swap / report swap per frame | VideoView.swift:551 → MPVController.swift:737-740 | `displayLinkCallback` 调 `mpv_render_context_report_swap` |
| 停链路 / stop link | VideoView.swift:237-241 | `stopDisplayLink()` |
| 省电杀链路（6s）/ energy-saving kill (6s) | VideoView.swift:299-312 | `displayIdle()` 武装定时器；306 行治本开关 / arms timer; line 306 root-fix switch |
| 救链路 / rescue link | VideoView.swift:280-283 | `displayActive()` 取消定时器 + 重启 / cancels timer + restart |
| 主触发点 / main trigger | PlayerCore.swift:2276-2293 | `pauseChanged` 按状态调 idle/active（2288/2291） |
| 再武装点 / re-arm point | MPVController.swift:1161-1169 | `playback-restart` 时若 `.paused` 再 idle（1168） |
| resume 先救 / resume rescues first | PlayerCore.swift:883-885 | `resume()` 先 `displayActive()` |
| 治本开关 / root-fix switch | Preference.swift:348 / 1027 | `enableDisplayIdle` 默认 true / defaults to true |

---

## 附：治本命令 / Appendix: Root-Fix Command

```bash
defaults write com.colliderli.iina enableDisplayIdle -bool false
```

**中文**：不改任何代码即可关闭 6 秒省电杀链路逻辑。改完后 `frame-drop-count` 稳定在 ~1，插件内的 Frame Drop Monitor 基本空转（双保险）。

**English**: Disables the 6-second energy-saving link-kill logic without touching any code. After this, `frame-drop-count` stays at ~1 and the plugin's Frame Drop Monitor is essentially idle (defense in depth).
