# 07 — Skip redundant per-frame work when no new frame arrived

## Problem

`my_xrEndFrame` (`native/openxr-layer/src/layer.cpp:473`) does the full dance
on **every** game frame (90-120 Hz):

- `readShmFrame` (SHM snapshot + mutex).
- `ensureSharedResources` (compare handles; usually a no-op after warmup, but
  still called).
- `context4->Wait(fence, frame.fenceValue)` (`:523`).
- Acquire/wait/release the swapchain + the fullscreen-triangle blit.

When the producer runs at 60 Hz and the game at 90-120 Hz, **half** the game
frames have no new producer content. We still re-do the handle check, the fence
wait, and re-blit identical pixels.

Caveat from the spec: you **cannot** simply skip the blit and reuse the last
swapchain image — OpenXR swapchains have a small image pool and the runtime may
hand back a **different** (empty) image on the next `xrAcquireSwapchainImage`,
which would show garbage. So the blit itself must repeat. The savings are in
the **surrounding** work.

## Goal

Avoid the cross-process handle check, the fence wait, and any SRV rebind work
on frames where `frameNumber` hasn't advanced — while still re-blitting the
cached texture so the swapchain image is always valid.

## Approach (step by step)

### 1. Track the last consumed frame

Add to `SessionState`:
```c
uint64_t lastConsumedFrameNumber = 0;
uint64_t lastConsumedFenceValue = 0;
SlotView* lastConsumedSlot = nullptr;  // pointer into slotViews[] (from #01)
```

### 2. Classify the frame in `my_xrEndFrame`

```c
IrdashiesShmHeader frame{};
const bool haveFrame = readShmFrame(frame);

bool newContent = false;
if (haveFrame) {
  const uint32_t idx = frame.latestIndex;
  newContent = (frame.frames[idx].frameNumber != g.lastConsumedFrameNumber) ||
               (g.lastConsumedSlot == nullptr);
}
```

### 3. Skip work when content is unchanged

When `haveFrame && !newContent`:

- **Skip** `ensureSharedResources` (we already hold the slot's texture open from
  `lastConsumedSlot`).
- **Skip** the fence `Wait` — we already waited for `lastConsumedFenceValue`
  and the producer won't touch this slot again until it laps the ring (and
  when it does, `frameNumber` changes and we take the new-content path).
- **Keep** acquire/wait/release + blit (swapchain image validity), but bind
  the **already-open** SRV (`g.lastConsumedSlot->srv`) instead of reopening.

When `haveFrame && newContent`: do the full path (open slot if handle changed,
wait fence, bind, blit), then update `lastConsumedFrameNumber`,
`lastConsumedFenceValue`, `lastConsumedSlot`.

When `!haveFrame`: unchanged — fallback pulse (`layer.cpp:552-560`).

### 4. Cheap fast-path for "producer gone, nothing shown"

If `!haveFrame` **and** we've decided not to show the fallback this frame (e.g.
a setting to hide the pulse), skip the swapchain entirely and pass
`frameEndInfo` through unmodified:

```c
if (!haveFrame && !g.showFallback) return g_next_xrEndFrame(session, frameEndInfo);
```

This pairs with #05's "don't append if nothing to show".

### 5. Invalidate the cache on producer identity change

If `frame.feederProcessId` changes (producer restarted), or the slot's
`textureHandle` differs from what `lastConsumedSlot` was opened from, drop the
cache and take the full new-content path. This is already handled by the
per-slot `texHandleVal` check in #01; just make sure `lastConsumedSlot` is
nulled when its slot is invalidated.

### 6. What **not** to do

- Do **not** skip `xrAcquireSwapchainImage` / `xrWaitSwapchainImage` /
  `xrReleaseSwapchainImage`. The runtime owns the image pool; skipping these
  breaks the contract and can show stale/empty images.
- Do **not** skip the blit but still submit the quad, expecting the previous
  image to persist — a different image index may be returned.
- Do **not** hold an acquired image across frames (only one outstanding
  acquire is allowed).

## Expected savings

Per skipped-content frame we remove: one mutex-bounded SHM snapshot (kept —
it's how we detect new content; cheap), one handle-equality compare, one GPU
fence wait (already usually non-blocking, but removes the API call), and the
SRV rebind bookkeeping. The blit (one triangle draw) remains. Net: modest but
free, and it shrinks the layer's footprint on the game's render thread —
valuable in a sim that's already GPU-bound.

## Code touch points

| File | Change |
| --- | --- |
| `native/openxr-layer/src/layer.cpp` | `lastConsumed*` fields; new-content classification; skip `ensureSharedResources`/fence wait/SRV reopen on unchanged frames; invalidate on PID/handle change. |

Depends on #01's per-slot `SlotView` cache.

## References

- OpenKneeboard `MaybeGet` semantics (`vr-website-rendering.md:52` cites
  `:219`): it returns a frame only when there's a new one, so the consumer
  naturally does less work when idle. Same idea here, but we must still re-blit
  for OpenXR swapchain correctness.
  https://github.com/OpenKneeboard/OpenKneeboard — `src/dll/SHM.h`
  (`MaybeGet`/`GetNext`).
- OpenXR swapchain acquire/wait/release lifecycle:
  https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html#swapchain-image-lifecycle
- D3D11 fence `Wait` on a shared fence:
  https://learn.microsoft.com/en-us/windows/win32/api/d3d11_4/nf-d3d11_4-id3d11devicecontext4-wait

## How to test

1. **Frame-number gating test (no headset, logic)** — feed a mock SHM that
   publishes `frameNumber` at 60 Hz and a fake "game" loop at 120 Hz. Count:
   - `ensureSharedResources` calls (should equal **unique** frameNumbers, not
     game frames).
   - fence `Wait` calls (same).
   - blit draws (should equal game frames — the blit is not skipped).
   Assert the first two counts are ~half the third.
2. **No-stall assertion** — with the producer steady at 60 Hz, confirm
   `context4->Wait` is never called when `frameNumber` is unchanged, so a
   stalled producer (e.g. producer paused on a breakpoint) does **not** stall
   the game's `xrEndFrame`. Today, every game frame waits on the fence value
   from the last published frame — fine while the fence is signalled, but the
   call still happens.
3. **Visual identical-ness** — run in-headset with a static dashboard (no
   telemetry updates). Confirm the overlay is perfectly stable (no flicker,
   no blank frames) even though we're skipping the heavy work on half the
   frames. This proves the "keep the blit" decision is correct.
4. **Producer restart invalidates cache** — kill and restart the Electron
   producer mid-session. Confirm `lastConsumedSlot` is invalidated (PID
   changed), the new slot is opened, and the next frame shows the new
   producer's content with no stale frame flash.
5. **Profiling** — use RenderDoc or OVR Metrics Tool to compare GPU time spent
   in the layer's command list per game frame, 60 Hz producer vs 120 Hz game.
   Expect ~flat blit cost and a drop in the surrounding overhead after the
   change.
