# irDashies VR — Follow-up fixes & polish

These are the seven review findings from the post-implementation audit of
`docs/vr/01..07`. Six are small, low-risk fixes; #6 is a **documentation-only**
item (the work itself is deferred to the atlas-page follow-up).

Each entry references the exact code location, explains the change, and gives a
verification step. None of them alter the SHM contract (no v3 bump), so they can
ship in any order unless noted.

## Quick reference

| #  | Finding                                  | Risk     | Touches            |
| -- | ---------------------------------------- | -------- | ------------------ |
| F1 | Race: `lastConsumedSlot` null deref      | crash    | consumer           |
| F2 | `pickFormat` enumerates every frame      | perf     | consumer           |
| F3 | `ourQuads` allocates every frame         | perf     | consumer           |
| F4 | Dead code / stale comments               | clarity  | consumer, producer |
| F5 | `sourceRect` offset not clamped          | OOB      | consumer           |
| F6 | `opacity` field is not implemented       | doc only | header, summary    |
| F7 | `setLayers` not mutex-guarded            | race     | producer           |

Recommended order: **F1 first** (crash), then F2/F3 (perf), then F4/F5/F7
(low-risk cleanup), F6 last (doc only).

---

## F1 — Fix the `lastConsumedSlot` race (null deref after producer restart)

### Problem

`native/openxr-layer/src/layer.cpp:589-594` invalidates `lastConsumedSlot`
**after** the new-content classification at `:566-587`:

```c
// :580-584 — when newContent==false, haveFrame depends on lastConsumedSlot
} else {
  haveFrame = (g.lastConsumedSlot != nullptr && g.lastConsumedSlot->srv != nullptr);
}
// ...
// :591-594 — invalidation happens AFTER classification
if (g.lastConsumedSlot && (g.feederPid != frame.feederProcessId ||
    g.lastConsumedSlot->texHandleVal != frame.frames[slotIdx].textureHandle)) {
  g.lastConsumedSlot = nullptr;
}
```

Sequence that triggers the crash:
1. Producer restarts. Its `frameCounter` starts at 1 again.
2. First frame after restart has `frameNumber == 1`, which may equal
   `g.lastConsumedFrameNumber` from the previous producer session.
3. `newContent` evaluates to `false` (line 569) → we take the else-branch and
   set `haveFrame = true` based on the stale `lastConsumedSlot`.
4. The invalidation block (591-594) then nulls `g.lastConsumedSlot`.
5. At line 670 the blit binds:
   ```c
   newContent ? &g.slotViews[slotIdx].srv : &g.lastConsumedSlot->srv
   ```
   `newContent` is false, so it dereferences the now-null `lastConsumedSlot` →
   **crash**.

The `frameNumber` collision is improbable (requires the producer to have
published exactly the same count before crashing) but a monotonic counter that
resets on restart makes it possible, and a crash inside `xrEndFrame` takes the
whole game down.

### Fix

**Move the invalidation before the classification.** The cache must reflect the
current producer identity before we decide whether the frame is "new".

```c
if (haveFrame) {
  slotIdx = frame.latestIndex;

  // Invalidate the cache FIRST if the producer identity changed (feeder PID
  // or this slot's texture handle differs from what we opened against).
  if (g.lastConsumedSlot &&
      (g.feederPid != frame.feederProcessId ||
       g.lastConsumedSlot->texHandleVal !=
           frame.frames[slotIdx].textureHandle)) {
    g.lastConsumedSlot = nullptr;
    g.lastConsumedFrameNumber = 0;
  }

  const auto& fslot = frame.frames[slotIdx];
  newContent = (fslot.frameNumber != g.lastConsumedFrameNumber) ||
               (g.lastConsumedSlot == nullptr);

  if (newContent) {
    haveFrame = ensureSlotResources(frame, slotIdx);
    if (haveFrame) {
      g.lastConsumedFrameNumber = fslot.frameNumber;
      g.lastConsumedFenceValue = frame.fenceValue;
      g.lastConsumedSlot = &g.slotViews[slotIdx];
    }
  } else {
    haveFrame = (g.lastConsumedSlot != nullptr &&
                 g.lastConsumedSlot->srv != nullptr);
  }
} else {
  g.lastConsumedSlot = nullptr;
}
```

Then delete the old invalidation block at 589-594.

As a **defence-in-depth**, also make the bind at line 670 robust so a future
logic error can't null-deref:

```c
ID3D11ShaderResourceView* srv =
    (newContent && slotIdx < IRDASHIES_SHM_RING_SIZE)
        ? g.slotViews[slotIdx].srv
        : (g.lastConsumedSlot ? g.lastConsumedSlot->srv : nullptr);
if (!srv) { /* release swapchain image and pass through */ }
dc->PSSetShaderResources(0, 1, &srv);
```

### Code touch points

| File | Change |
| --- | --- |
| `native/openxr-layer/src/layer.cpp` | Move invalidation before classification (591-594 → before 566); harden the SRV bind at 670. |

### How to test

1. **Reproducer (no headset)** — extend `irdashies-shm-probe` into a loop that:
   - Reads frames from producer instance A for a few seconds.
   - Kills A, starts producer instance B (new PID, `frameCounter` resets to 1).
   - Continues reading.
   - Today: crash or garbage. After fix: clean handoff, B's frames read
     correctly with a "Opened shared texture ... from producer PID" log line.
2. **In-headset** — run the Electron producer, kill it (`stop`), restart it
   (`start`) mid-iRacing-session. The overlay should reappear within a couple
   frames with no game crash and a single "Opened shared texture" log line for
   the new PID.
3. **Log check** — `irdashies-openxr-layer.log` should show exactly one
   "Opened shared texture slot N ... from producer PID X" per slot per producer
   instance, never a gap or a crash trace.

---

## F2 — Cache `pickFormat` (enumerate swapchain formats once)

### Problem

`native/openxr-layer/src/layer.cpp:627` calls `pickFormat(srcFmt)` on **every**
`xrEndFrame` (90-120 Hz). `pickFormat` (`:478-493`) calls
`xrEnumerateSwapchainFormats` **twice** (count, then fill) plus allocates a
`std::vector<int64_t>` each call. The set of supported formats does not change
during a session.

### Fix

Enumerate once in `my_xrCreateSession` and cache the result in `SessionState`:

```c
// in SessionState:
std::vector<int64_t> supportedFormats;

// in my_xrCreateSession, after the swapchain-format enumeration is possible:
uint32_t fmtCount = 0;
g_next_xrEnumerateSwapchainFormats(g.session, 0, &fmtCount, nullptr);
g.supportedFormats.resize(fmtCount);
g_next_xrEnumerateSwapchainFormats(g.session, fmtCount, &fmtCount,
                                   g.supportedFormats.data());
```

Rewrite `pickFormat` to take the cached vector:

```c
static int64_t pickFormat(DXGI_FORMAT srcFormat,
                          const std::vector<int64_t>& formats) {
  for (int64_t f : formats) if (f == (int64_t)srcFormat) return f;
  for (int64_t want : {(int64_t)DXGI_FORMAT_B8G8R8A8_UNORM,
                       (int64_t)DXGI_FORMAT_R8G8B8A8_UNORM}) {
    for (int64_t f : formats) if (f == want) return f;
  }
  return formats.empty() ? (int64_t)DXGI_FORMAT_R8G8B8A8_UNORM : formats.front();
}
```

Call site at `:627` becomes:
```c
fmt = pickFormat(srcFmt, g.supportedFormats);
```

Note: `g.supportedFormats` is read-only on the hot path and only written once at
session create, so no synchronization is needed.

### Code touch points

| File | Change |
| --- | --- |
| `native/openxr-layer/src/layer.cpp` | Add `supportedFormats` to `SessionState`; enumerate in `my_xrCreateSession`; rewrite `pickFormat` to use the cache. |

### How to test

1. **No per-frame enumeration** — run a session under the Visual Studio
   performance profiler and confirm `xrEnumerateSwapchainFormats` appears only
   at session create, never inside `my_xrEndFrame`.
2. **Format selection unchanged** — run the probe/producer with a BGRA and an
   RGBA producer variant; the selected swapchain format and `needsSwizzle` flag
   must match the pre-change behaviour (covered by #02's tests).
3. **Empty-format fallback** — if you can simulate a runtime reporting zero
   supported formats (hard with real runtimes), confirm the fallback to
   `R8G8B8A8_UNORM` still kicks in without crashing.

---

## F3 — Reuse `ourQuads` (complete the #05 no-alloc goal)

### Problem

`native/openxr-layer/src/layer.cpp:691` declares
`std::vector<XrCompositionLayerQuad> ourQuads;` as a **local** in `my_xrEndFrame`,
so it heap-allocates every frame. `g.outLayers` was made a reused member (per
#05), but `ourQuads` — up to 16 quads of ~400 bytes each — was missed. This is
exactly the per-frame churn #05 was meant to eliminate.

### Fix

Move it to `SessionState` with a one-time reserve, and `clear()` per frame:

```c
// in SessionState:
std::vector<XrCompositionLayerQuad> ourQuads;

// in my_xrCreateSession, after the maxLayerCount query:
g.ourQuads.reserve(IRDASHIES_SHM_MAX_LAYERS);
```

In `my_xrEndFrame`, replace line 691:
```c
g.ourQuads.clear();
// ... existing push_back loop unchanged, but push into g.ourQuads
```

And update the append loop at `:776` to iterate `g.ourQuads`.

`clear()` on a reserved vector does not reallocate, so capacity stays at 16 and
there is zero heap traffic on the hot path.

### Code touch points

| File | Change |
| --- | --- |
| `native/openxr-layer/src/layer.cpp` | Add `ourQuads` to `SessionState`; reserve in `my_xrCreateSession`; replace the local at 691. |

### How to test

1. **No per-frame allocation** — profile a long session and confirm
   `my_xrEndFrame` shows no `std::vector` allocation after the first frame
   (both `outLayers` and `ourQuads` should be stable). Compare against current
   build, which allocates `ourQuads` every frame.
2. **Capacity assertion** — add a temporary `assert(g.ourQuads.capacity() >=
   IRDASHIES_SHM_MAX_LAYERS)` after warmup; it must hold for the whole session.
3. **Functional parity** — with the test producer publishing 4 layers,
   in-headset behaviour (4 quads, correct sub-rects) must be identical to before.

---

## F4 — Remove dead code and stale comments

### Problem

Several leftovers from earlier iterations no longer reflect the current code:

| Location | Issue |
| --- | --- |
| `layer.cpp:8-10` | Header comment says "falls back to an animated solid color" — the fallback was removed. |
| `layer.cpp:149` | `kFallbackSize = 512` is no longer used (line 637 returns before the path that referenced it). |
| `layer.cpp:620-622` | `haveFrame ? slot.width : kFallbackSize` — the `!haveFrame` branch is unreachable (637 returns). |
| `layer.cpp:169, 878-886` | `stageSpace` is created but never used; the quad uses `localSpace`. Either use it or remove it. |
| `layer.cpp:194` | `needsSwizzle` is a `SessionState` member but set as a local each frame — doesn't need to persist. |
| `vr_overlay.cc:14` | Comment "MVP: a single overlay/quad" — the multi-quad infrastructure is in place. |

### Fix

- **`layer.cpp:8-10`** — rewrite to: "If no producer is running the layer is a
  pure pass-through (no swapchain, no quad, zero overhead)."
- **`kFallbackSize`** — delete the constant and simplify lines 620-622 to use
  `slot.width`/`slot.height` directly (the `!haveFrame` path already returned
  at 637). If `kFallbackSize` is genuinely dead, remove it; if you want to keep
  a guard, assert `haveFrame` before the line.
- **`stageSpace`** — decide:
  - If the intent is for the quad to follow iRacing's recenter (the original
    comment at `:878`), wire `q.space = g.stageSpace` in the quad builders and
    test it moves with iRacing's recenter. **Or**
  - Delete the creation block (`:878-886`), the field in `SessionState` (`:169`),
    and the destroy in `my_xrDestroySession` (`:921`).
  - Given recenter is already handled via the `recenterPose` math, **deleting**
  is the cleaner choice unless someone confirms STAGE is needed.
- **`needsSwizzle`** — demote to a local `bool needsSwizzle` in `my_xrEndFrame`
  (it's recomputed every frame anyway and doesn't need to persist).
- **`vr_overlay.cc:14`** — update to: "Multi-quad via SHM layer table
  (`setLayers`); the frontend atlas page is a follow-up."

### Code touch points

| File | Change |
| --- | --- |
| `native/openxr-layer/src/layer.cpp` | Comment fix; remove `kFallbackSize` + dead branch; remove or use `stageSpace`; demote `needsSwizzle` to local. |
| `src/app/vr/native/vr_overlay.cc` | Update header comment. |

### How to test

1. **Build clean** — `cmake --build build --config Release` and the node-gyp
   build must succeed with no new warnings.
2. **Behaviour unchanged** — run the test producer + `hello_xr` (force-on) and
   iRacing; overlay placement/recenter must be identical to before. If you
   removed `stageSpace`, explicitly verify recenter still works (it should,
   since the math uses `recenterPose`, not `stageSpace`).
3. **Grep for orphans** — after the change, `grep -n stageSpace` and
   `grep -n kFallbackSize` in `layer.cpp` should return nothing (or only the
   intended usage if you kept it).

---

## F5 — Clamp `sourceRect` offset, not just extent

### Problem

`native/openxr-layer/src/layer.cpp:704-709` clamps the `sourceRect` **extent**
to the swapchain dimensions, but does not clamp the **offset**:

```c
q.subImage.imageRect.offset.x = (int32_t)layer.sourceRect[0];   // unclamped
q.subImage.imageRect.offset.y = (int32_t)layer.sourceRect[1];   // unclamped
q.subImage.imageRect.extent.width  = (int32_t)std::min(layer.sourceRect[2], (float)w);
q.subImage.imageRect.extent.height = (int32_t)std::min(layer.sourceRect[3], (float)h);
```

If a layer publishes `sourceRect = {x: 1800, y: 0, w: 512, h: 512}` on a 2048
swapchain, the extent is clamped to 512 but `offset.x + extent.width = 2312`
exceeds 2048 → the runtime samples beyond the swapchain image bounds. Behaviour
is implementation-defined (clamping, garbage, or a validation error).

This can happen if the OSR window is resized smaller than the atlas layout
expects, or if a widget's `sourceRect` is computed against a stale atlas size.

### Fix

Clamp the offset to `[0, swapchainDim - 1]` and re-derive the extent so
`offset + extent <= swapchainDim`:

```c
auto clampRect = [](float x, float y, float w, float h,
                    uint32_t maxW, uint32_t maxH,
                    XrRect2Di& out) {
  int32_t ox = std::max(0, std::min((int32_t)x, (int32_t)maxW - 1));
  int32_t oy = std::max(0, std::min((int32_t)y, (int32_t)maxH - 1));
  int32_t ex = std::max(0, std::min((int32_t)w, (int32_t)maxW - ox));
  int32_t ey = std::max(0, std::min((int32_t)h, (int32_t)maxH - oy));
  out.offset = {ox, oy};
  out.extent = {(uint32_t)ex, (uint32_t)ey};
};
clampRect(layer.sourceRect[0], layer.sourceRect[1],
          layer.sourceRect[2], layer.sourceRect[3],
          w, h, q.subImage.imageRect);
```

The key addition is `(int32_t)maxW - ox` for the extent bound, which guarantees
`offset + extent <= maxW`.

Apply the same clamp to the fallback single-quad path at `:742` (which uses
`{{0,0},{w,h}}` — already safe, but symmetric for clarity).

### Code touch points

| File | Change |
| --- | --- |
| `native/openxr-layer/src/layer.cpp` | Add `clampRect` helper; use it in the layer-table loop (704-709). |

### How to test

1. **Out-of-bounds producer (no headset, validation layer)** — extend the test
   producer to publish a layer with `sourceRect = {x: 2000, y: 0, w: 512, h:
   512}` on a 2048 atlas. Load the layer under an OpenXR debug-active runtime
   (or `hello_xr` with `XR_LOADER_DEBUG=all` + the OpenXR validation layer).
   - Before: validation error for OOB `imageRect`, or garbage sampling.
   - After: the rect is clamped to `{2000,0,48,512}` (2048-2000=48), no
     validation error, no garbage.
2. **Normal case unchanged** — publish layers with in-bounds `sourceRect`s and
   confirm the quad content/positioning is identical to before.
3. **Zero-size guard** — publish a layer fully outside the atlas
   (`sourceRect = {5000,5000,512,512}`); after clamping the extent is 0.
   Confirm the consumer skips it (a zero-size quad is invalid) rather than
   submitting it. Add `if (extent.width == 0 || extent.height == 0) continue;`
   after the clamp.

---

## F6 — Document `opacity` as not yet implemented (documentation only)

### Problem

`IrdashiesShmLayer.opacity` (`native/shared/irdashies_shm.h:45`) is in the SHM
contract and the producer publishes it (`vr_overlay.cc:432-433`), but the
consumer **never reads it** — the blit shader copies texels as-is
(`layer.cpp:295-299`), and `XrCompositionLayerQuad` has no opacity field anyway.
A reader of the header would reasonably assume per-widget opacity works.

OpenXR does not provide a quad-level opacity control. The only blend controls
are `layerFlags` (`BLEND_TEXTURE_SOURCE_ALPHA`, `UNPREMULTIPLIED_ALPHA`), which
use the texture's own alpha. So per-layer opacity must be **baked into the
texture during the blit** by multiplying the texel's RGB and A by the layer's
opacity in the pixel shader.

### Why not implement now

- No UI sets `opacity` to anything other than 1.0 today (see `vrOverlay.ts:93`).
- The blit is currently a **single fullscreen-triangle draw** for the whole
  atlas. Per-layer opacity requires **one draw per layer with a scissor rect**
  restricted to that layer's `sourceRect`, passing the layer's opacity as a
  shader constant. That's N draws (N ≤ 16) instead of 1 — trivial for the GPU,
  but it's a real change to the blit loop that only pays off once the atlas page
  exists and the opacity UI is wired.
- Implementing the consumer side now turns "dead field" into "works but nobody
  can change it", which doesn't advance anything real.

The right moment is the **atlas-page follow-up** (`08-implementation-summary.md`
"Future work"), where the per-widget `sourceRect` and opacity UI land together.

### Fix (documentation only, for now)

1. **`native/shared/irdashies_shm.h:45`** — annotate the field:
   ```c
   float opacity;  // 0..1 — NOT YET read by the consumer; wired up with the
                   // atlas page (per-layer blit + scissor + shader multiply).
   ```
2. **`docs/vr/08-implementation-summary.md`** — in "Future work", change the
   opacity bullet from a vague "not wired to any settings UI yet" to:
   > **Opacity** — the `opacity` field is in the SHM contract and published by
   > the producer, but the consumer does not yet read it (the blit shader copies
   > texels as-is, and OpenXR has no quad-level opacity control). Implementing
   > it requires: (a) a per-layer blit with a scissor rect set to the layer's
   > `sourceRect`, (b) passing `opacity` as a shader constant, (c) multiplying
   > `rgb * opacity` and `a * opacity` in the pixel shader (Chromium OSR
   > textures are premultiplied, so both must be scaled), and (d) using
   > `XR_COMPOSITION_LAYER_UNPREMULTIPLIED_ALPHA_BIT` is NOT correct here —
   > keep `BLEND_TEXTURE_SOURCE_ALPHA_BIT` since we premultiply in-shader. This
   > is deferred to the atlas-page follow-up where the opacity UI lands with it.

### How to test (the doc change)

1. `grep -n "opacity" native/shared/irdashies_shm.h` shows the comment.
2. A new reader of the header can tell from the comment alone that the field is
   reserved-but-inert, without having to grep the consumer.

### When this becomes real work (for reference, do not implement now)

The implementation, when the time comes, is:

```hlsl
// new pixel shader variant (or a constant buffer on the existing one):
float4 main(float4 pos:SV_Position, float2 uv:TEXCOORD0):SV_Target{
  float4 c = tex.Sample(smp, uv);
  return float4(c.rgb * g_opacity, c.a * g_opacity);  // premultiplied
}
```

And the blit loop becomes, per visible layer:

```c
for each layer:
  // scissor to the layer's clamped sourceRect (F5)
  D3D11_RECT scissor{ rect.offset.x, rect.offset.y,
                      rect.offset.x + rect.extent.width,
                      rect.offset.y + rect.extent.height };
  dc->RSSetScissorRects(1, &scissor);
  // set opacity constant
  // draw fullscreen triangle (the scissor restricts it to the sub-rect)
```

Because the scissor restricts the draw to each layer's sub-rect, the UVs must
map the **whole atlas** to the fullscreen triangle (the current UV math already
does this), and the scissor selects which slice of the swapchain gets written.
The runtime then samples each quad's `imageRect` from the swapchain — which
contains only that layer's opacity-adjusted pixels.

---

## F7 — Guard `setLayers` with the SHM mutex

### Problem

`src/app/vr/native/vr_overlay.cc:411-439` (`SetLayers`) writes into the
producer-side `g.layers[]` and `g.layerCount` **without** taking `g.mutex`,
while `SubmitFrame` (`:379-388`) reads `g.layers[]`/`g.layerCount` under the
mutex and copies them into SHM.

Node.js is single-threaded, so in normal operation the two cannot run
concurrently. But:
- A `setLayers` call on the same tick as a `paint` callback (both are JS
  callbacks queued by libuv) could interleave at the C++ boundary if a future
  change makes the producer pump frames off-thread, or if the
  `NAPI_DISABLE_CPP_EXCEPTIONS` guard introduces a re-entrancy path.
- More importantly: `SubmitFrame` reads `g.layerCount` and then loops
  `g.layers[i]` — if `setLayers` shrinks `layerCount` between the read and the
  loop (impossible today, but defensive), the loop could read a stale entry.

The cost of guarding is one mutex acquire/release per `setLayers` call (rare —
only on settings change), so there's no reason not to.

### Fix

Wrap the `SetLayers` body in the same mutex pattern used by `SetPose`:

```c
Napi::Value SetLayers(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsArray()) return env.Undefined();
  Napi::Array arr = info[0].As<Napi::Array>();
  uint32_t n = arr.Length();
  if (n > IRDASHIES_SHM_MAX_LAYERS) n = IRDASHIES_SHM_MAX_LAYERS;

  if (g.mutex) WaitForSingleObject(g.mutex, INFINITE);
  for (uint32_t i = 0; i < n; ++i) {
    // ... existing parsing into g.layers[i] ...
  }
  g.layerCount = n;
  if (g.mutex) ReleaseMutex(g.mutex);

  return env.Undefined();
}
```

Note: the mutex here is the **SHM mutex** (`g.mutex`, the named kernel mutex),
which `SubmitFrame` also takes. This makes `setLayers` atomic with respect to
`SubmitFrame`'s read of `g.layers`/`g.layerCount`. The JS-level array parsing
could be done outside the mutex to minimise hold time, but the parse is cheap
and keeping it simple is fine.

### Code touch points

| File | Change |
| --- | --- |
| `src/app/vr/native/vr_overlay.cc` | Wrap `SetLayers` body in `WaitForSingleObject`/`ReleaseMutex`. |

### How to test

1. **Functional parity** — toggle `setLayers` with different layer counts during
   a running producer; the consumer must see consistent `layerCount`/`layers[]`
   pairs (never a `layerCount` of 4 with only 2 populated entries). This is hard
   to observe today because of single-threading, but the guard makes it
   guaranteed.
2. **No deadlock** — call `setLayers` rapidly during a frame-heavy session and
   confirm no hang (the mutex is non-recursive; ensure `setLayers` doesn't call
   anything that re-enters `SubmitFrame`).
3. **Stress (if you ever go multi-threaded)** — if a future change pumps frames
   on a worker, this guard is what prevents the torn read. Add a comment noting
   it's defence-in-depth for that future case.
