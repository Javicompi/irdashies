# 14 — Debug and fix the multi-quad consumer freeze

## Context

The VR edit mode (`#11`) is implemented and working **except** for the key
feature: per-widget quads. When `publishVrLayers` switches from publishing 1
full-atlas quad to publishing N per-widget quads (one per widget + one for the
instructions panel), the OpenXR runtime **freezes the game**. This was tested
twice and reproduced both times.

The current workaround (commit `f392d137`) is to always publish a single
full-atlas quad. The edit-mode UI (green borders, instructions panel) is
rendered into the atlas texture by React. This gives the user all the
edit-mode controls, but **widgets do not move visually** in the headset because
they all share one quad with one pose.

This document covers: (1) the likely root causes, (2) a systematic debugging
plan, and (3) the fix once the cause is found.

## Current state of the code

### Producer (`src/app/vr/vrOverlay.ts:61-79`)

`publishVrLayers` currently always publishes 1 layer:

```typescript
VrOverlayNative.setLayers([
  {
    position: pose.position ?? DEFAULT_POSE.position,
    orientation: pose.orientation ?? DEFAULT_POSE.orientation,
    size: pose.size ?? DEFAULT_POSE.size,
    sourceRect: [0, 0, atlasTexW, atlasTexH],
    opacity: 1,
    visible: 1,
  },
]);
```

The per-widget path was removed in `f392d137`. It looked like:

```typescript
const layers = atlasLayout.map((slot) => ({
  position: getWidgetVrPosition(slot.widgetId, pose),
  orientation: pose.orientation ?? DEFAULT_POSE.orientation,
  size: pose.size ?? DEFAULT_POSE.size,
  sourceRect: slot.sourceRect,
  opacity: 1,
  visible: 1,
}));
// + one instructions quad
VrOverlayNative.setLayers(layers);
```

### Consumer (`native/openxr-layer/src/layer.cpp:693-788`)

The consumer N-quad loop is **intact and was never disabled**. It reads
`frame.layerCount` and `frame.layers[]` from SHM, builds one
`XrCompositionLayerQuad` per visible layer with its own `imageRect` and pose,
and appends them to the game's layer list. When `layerCount` is 0 or all
layers are invisible, it falls back to the single-quad path from the shared
pose fields (`:742-770`).

This means: when the producer publishes a single full-atlas layer (current
behaviour), the consumer takes the `lc > 0` path (`:698`) and builds **one**
quad from `frame.layers[0]` — which has `sourceRect = [0, 0, atlasTexW,
atlasTexH]` and the shared pose. That works. The freeze only happens when N
grows beyond 1-2.

## Suspected root causes (in order of likelihood)

### A. All quads share the same swapchain and the same image index

Every `XrCompositionLayerQuad` built by the consumer references
`g.swapchain` (`:706`) with `imageArrayIndex = 0` (`:717`). They all point to
the **same swapchain image** (acquired once at `:645`, released once at
`:691`).

The OpenXR spec says a swapchain image must be **released** before the runtime
composites it. Multiple composition layers referencing the same swapchain
image is allowed by the spec, but some runtimes may not handle it correctly —
especially if the layers have different `imageRect` sub-regions of the same
image. The runtime may try to sample the same image from multiple layers
simultaneously and hit an internal synchronization issue.

This is the most likely cause because it only manifests with multiple quads,
and the single-quad path works fine.

### B. `maxLayerCount` budget exceeded

The budget logic (`:779-788`) caps the total at
`gameLayerCount + ourBudget`. If iRacing uses several layers itself and the
runtime's `maxLayerCount` is small (some runtimes report as few as 4), adding
N widget quads + 1 instructions quad may exceed it. The budget code drops
excess quads, but the runtime may still see a partial set and fail.

The `maxLayerCount` query (`:893-903`) falls back to 1 when
`xrGetSystemProperties` is unavailable. If that fallback kicked in, only 1
quad would be allowed, and publishing 2+ would be silently dropped. But a
silent drop shouldn't freeze the game — it would just show 1 quad. So this is
less likely to cause the freeze, but worth verifying.

### C. Fence wait deadlock

The fence wait (`:654`) happens once per `xrEndFrame`:
```cpp
if (newContent) g.context4->Wait(g.fence, frame.fenceValue);
```

This waits on the **immediate** context. If the runtime's compositor is
blocking on a layer that references the swapchain image, and the fence wait
blocks the immediate context, the runtime may deadlock waiting for the frame
to complete while the frame is waiting for the fence.

This is less likely with a single quad (the wait completes quickly), but with
N quads the runtime may take longer to composite, widening the window for a
deadlock.

### D. Invalid `sourceRect` or `quadSizeMeters`

If the per-widget `sourceRect` values from `atlasLayout` don't match the
swapchain dimensions (e.g. they're in CSS pixels, not backing-store pixels),
the runtime may sample out of bounds. The clamp code (`:708-715`) should
prevent this, but if `w`/`h` are wrong (e.g. 0 or the wrong slot), the clamp
may produce a zero-size rect, which is then skipped (`:713`), or a rect that
covers the wrong area.

Similarly, if `quadSizeMeters` is `[0, 0]` (the producer sends the shared pose
size, which could be wrong for per-widget quads), the quad is degenerate and
the runtime may reject the frame.

## Debugging plan

### Step 1 — Add diagnostic logging to the consumer

Add temporary logging at key points in `my_xrEndFrame` to capture the state
when the freeze happens. Since the game freezes, the log must be flushed
before the problematic call. Write to the existing log file
(`irdashies-openxr-layer.log`).

**File:** `native/openxr-layer/src/layer.cpp`

Before the `g_next_xrEndFrame` call at `:790`:

```cpp
layerLog("xrEndFrame: gameCount=%u ourBudget=%u ourQuads=%u appended=%u "
         "swapchain=%ux%u layerCount=%u",
         gameCount, ourBudget, (uint32_t)g.ourQuads.size(), appended,
         g.width, g.height, frame.layerCount);
for (uint32_t i = 0; i < g.ourQuads.size() && i < 4; ++i) {
  const auto& q = g.ourQuads[i];
  layerLog("  quad[%u]: rect=[%d,%d %ux%u] pos=[%.2f,%.2f,%.2f] size=[%.2f,%.2f]",
           i, q.subImage.imageRect.offset.x, q.subImage.imageRect.offset.y,
           q.subImage.imageRect.extent.width, q.subImage.imageRect.extent.height,
           q.pose.position.x, q.pose.position.y, q.pose.position.z,
           q.size.width, q.size.height);
}
```

Also log the result of `xrEndFrame`:

```cpp
XrResult res = g_next_xrEndFrame(session, &patched);
if (XR_FAILED(res)) {
  layerLog("xrEndFrame FAILED: %d", (int)res);
}
return res;
```

### Step 2 — Test with exactly 2 quads (minimal reproduction)

Modify `publishVrLayers` temporarily to publish exactly 2 layers (the
full-atlas quad + a second identical one with a slightly offset position):

```typescript
VrOverlayNative.setLayers([
  {
    position: pose.position ?? DEFAULT_POSE.position,
    orientation: pose.orientation ?? DEFAULT_POSE.orientation,
    size: pose.size ?? DEFAULT_POSE.size,
    sourceRect: [0, 0, atlasTexW, atlasTexH],
    opacity: 1,
    visible: 1,
  },
  {
    position: [0.1, 0, -1.4],  // slightly right + closer
    orientation: [0, 0, 0, 1],
    size: pose.size ?? DEFAULT_POSE.size,
    sourceRect: [0, 0, atlasTexW, atlasTexH],
    opacity: 1,
    visible: 1,
  },
]);
```

This isolates the issue: if 2 identical full-atlas quads freeze, it's a
multi-quad / swapchain-sharing issue (suspect A). If they don't freeze, the
problem is in the per-widget `sourceRect` or pose values (suspect D).

### Step 3 — Check `maxLayerCount`

Check `irdashies-openxr-layer.log` for the `Runtime maxLayerCount = N` line
(from `:900`). If N is 1 or 2, the budget is too small for multiple quads.

If the query failed (fell back to 1), the log shows no `maxLayerCount` line.
In that case, hardcode a higher value temporarily:

```cpp
g.maxLayerCount = 16;  // temporary override for debugging
```

### Step 4 — Test with per-swapchain-image quads (isolation test for A)

If step 2 confirms that 2 quads on the same swapchain freeze, test whether
the issue is swapchain sharing. This requires creating a **second**
swapchain for the second quad. This is a larger change (the consumer
currently has one swapchain), but it isolates the cause:

- If 2 quads on 2 separate swapchains work → the runtime can't handle
  multiple layers on the same swapchain image. Fix: use one swapchain per
  layer, or use a single quad that covers the full atlas and let the
  compositor handle sub-regions (which is what the spec intends, but some
  runtimes don't support it).
- If 2 quads on 2 swapchains also freeze → the issue is elsewhere (fence,
  pose, or runtime limit).

### Step 5 — Move the fence wait to the deferred context (isolation test for C)

If the fence wait on the immediate context is causing a deadlock, moving it
to the deferred context (so it's part of the command list executed with
`RestoreContextState=TRUE`) may fix it:

```cpp
// Instead of:
if (newContent) g.context4->Wait(g.fence, frame.fenceValue);

// Use:
if (newContent && g.deferred) {
  // Wait on the deferred context so it's part of our command list,
  // not blocking the game's immediate context.
  ID3D11DeviceContext4* deferred4 = nullptr;
  g.deferred->QueryInterface(IID_PPV_ARGS(&deferred4));
  if (deferred4) {
    deferred4->Wait(g.fence, frame.fenceValue);
    deferred4->Release();
  } else {
    g.context4->Wait(g.fence, frame.fenceValue);
  }
} else if (newContent) {
  g.context4->Wait(g.fence, frame.fenceValue);
}
```

Note: D3D11 deferred contexts support `ID3D11DeviceContext4::Wait` only on
hardware that supports fences. The `QueryInterface` may fail; the fallback
keeps the current behaviour.

## Most likely fix

Based on the analysis, the most likely cause is **A** (multiple layers
referencing the same swapchain image). The OpenXR spec allows it, but
runtimes may not. There are two approaches to fix this:

### Approach 1 — One swapchain per layer (robust, more memory)

Create a separate swapchain for each layer. The consumer already has
`ensureSwapchain` — extend it to create N swapchains indexed by layer. Each
layer's `subImage.swapchain` points to its own swapchain. The blit draws each
layer's sub-rect into its own swapchain image.

Pros: each runtime handles this correctly (it's the standard pattern).
Cons: N swapchains → N acquire/wait/release cycles per frame. More GPU
overhead, more memory. For 5-10 widgets, still manageable.

### Approach 2 — One big quad, let the compositor handle sub-rects (spec-compliant, efficient)

Keep one swapchain and one quad, but set `imageRect` to the **full atlas**
(not a per-widget sub-rect). The quad shows the entire atlas — all widgets
together. Per-widget positioning is then done by **moving the widget's
content within the atlas texture** (React renders the widget at the right
position on the atlas page), and the quad's pose is the shared pose.

This is what the current workaround already does. The downside is that all
widgets share one quad pose — you can't place them independently in 3D. But
the edit mode can still work: the user adjusts the **shared** pose (all
widgets move together). That's the current behaviour.

### Approach 3 — One quad per layer, but each with a unique swapchain image (hybrid)

Use one swapchain with `arraySize` or multiple images, and assign a different
`imageArrayIndex` per layer. The spec allows `imageArrayIndex` > 0 for
swapchains created with `arraySize > 1` (cube maps, etc.). This is more
complex and may not be supported by all runtimes for 2D textures.

### Recommendation

**Start with Approach 1** (one swapchain per layer) for correctness. It's the
most reliable and is what OpenKneeboard does (each layer has its own
swapchain). Once it works, optimize to Approach 2 if performance requires it
(one big quad with the atlas, letting React handle per-widget positioning
within the atlas).

## Implementation of Approach 1 (one swapchain per layer)

### Consumer changes (`native/openxr-layer/src/layer.cpp`)

#### 1. Replace single swapchain with a per-layer swapchain pool

```cpp
struct LayerSwapchain {
  XrSwapchain swapchain = XR_NULL_HANDLE;
  int64_t format = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<ID3D11Texture2D*> images;
  std::vector<ID3D11RenderTargetView*> rtvs;
};

// In SessionState:
std::vector<LayerSwapchain> layerSwapchains;
```

#### 2. Create/resize swapchains per layer

For each visible layer, create a swapchain sized to the layer's
`sourceRect` extent (not the full atlas). If a layer's `sourceRect` changes
size, recreate just that layer's swapchain.

```cpp
static bool ensureLayerSwapchain(uint32_t layerIdx, uint32_t w, uint32_t h,
                                  int64_t format) {
  if (layerIdx >= g.layerSwapchains.size())
    g.layerSwapchains.resize(layerIdx + 1);
  auto& ls = g.layerSwapchains[layerIdx];
  if (ls.swapchain && ls.width == w && ls.height == h && ls.format == format)
    return true;
  // destroy + recreate (same as ensureSwapchain but per-layer)
  // ...
}
```

#### 3. Blit each layer's sub-rect into its own swapchain image

The blit loop becomes, per layer:

```cpp
for (uint32_t i = 0; i < layerCount; ++i) {
  const auto& layer = frame.layers[i];
  if (!layer.visible) continue;
  // clamp sourceRect
  // ensureLayerSwapchain(i, ew, eh, fmt)
  // acquire/wait image
  // blit: set viewport to [ew, eh], set SRV to the atlas texture,
  //       but with a shader that samples only the sourceRect sub-region
  // release image
  // build XrCompositionLayerQuad with subImage.swapchain = ls.swapchain,
  //   imageRect = full image (no sub-rect needed)
}
```

The blit shader needs to sample only the `sourceRect` region of the atlas
texture. The current fullscreen-triangle shader maps UV `[0,0]`–`[1,1]` to
the whole texture. For per-layer blits, adjust the UVs to map to the
`sourceRect` region:

```
uMin = sourceRect.x / atlasWidth
uMax = (sourceRect.x + sourceRect.w) / atlasWidth
vMin = sourceRect.y / atlasHeight
vMax = (sourceRect.y + sourceRect.h) / atlasHeight
```

This can be done with a constant buffer or by adjusting the vertex shader
constants. The simplest approach: pass the UV offset/scale as shader
constants via `UpdateSubresource` on a small cbuffer, or bake them into the
vertex shader by generating a different vertex buffer per layer. The cheapest
for a fullscreen triangle is a cbuffer with `uvOffset` and `uvScale`:

```hlsl
// VS: o.uv = uv * uvScale + uvOffset;
```

Alternatively, use `D3D11_BOX` blits (`CopySubresourceRegion`) instead of a
shader blit. This is simpler: copy the sub-rect from the atlas texture to the
layer's swapchain image. No shader changes needed, but requires the formats
to match (the atlas and swapchain must be the same format).

#### 4. Use `CopySubresourceRegion` instead of shader blit (simpler)

For each layer:

```cpp
D3D11_BOX srcBox;
srcBox.left = ox;
srcBox.top = oy;
srcBox.right = ox + ew;
srcBox.bottom = oy + eh;
srcBox.front = 0;
srcBox.back = 1;
// Copy from atlas texture to layer swapchain image
dc->CopySubresourceRegion(
    ls.images[imgIdx], 0, 0, 0, 0,
    g.sharedTexture, 0, &srcBox);
```

This is simpler than a shader blit but requires the atlas and swapchain to be
the same format. The atlas is BGRA8 (from Chromium); the swapchain can be
picked to match (`pickFormat` already prefers the source format).

The downside: `CopySubresourceRegion` doesn't do swizzle. If the runtime
needs a different format, the shader blit with per-layer UVs is needed. For
the MVP, force the swapchain format to match the atlas and use
`CopySubresourceRegion`.

## Producer changes (`src/app/vr/vrOverlay.ts`)

Once the consumer supports per-layer swapchains, re-enable the per-widget
`publishVrLayers` path:

```typescript
function publishVrLayers(): void {
  if (!osrWindow) return;
  const pose = currentVrPose ?? DEFAULT_POSE;

  if (vrEditMode) {
    // Per-widget quads
    const layers = atlasLayout.map((slot) => ({
      position: getWidgetVrPosition(slot.widgetId, pose),
      orientation: pose.orientation ?? DEFAULT_POSE.orientation,
      size: pose.size ?? DEFAULT_POSE.size,
      sourceRect: slot.sourceRect,
      opacity: 1,
      visible: 1,
    }));
    // Instructions quad
    const instrH = 200;
    layers.push({
      position: [0, -0.15, -1.2],
      orientation: [0, 0, 0, 1],
      size: pose.size ?? DEFAULT_POSE.size,
      sourceRect: [0, atlasTexH - instrH, atlasTexW, instrH],
      opacity: 1,
      visible: 1,
    });
    VrOverlayNative.setLayers(layers);
    return;
  }

  // Normal mode: single full-atlas quad
  VrOverlayNative.setLayers([
    {
      position: pose.position ?? DEFAULT_POSE.position,
      orientation: pose.orientation ?? DEFAULT_POSE.orientation,
      size: pose.size ?? DEFAULT_POSE.size,
      sourceRect: [0, 0, atlasTexW, atlasTexH],
      opacity: 1,
      visible: 1,
    },
  ]);
}
```

No SHM contract change needed — `IrdashiesShmLayer[]` already has
`posePosition`, `sourceRect`, etc.

## How to test

1. **2-quad reproduction test** (step 2 above) — launch iRacing with VR.
   Before the fix: 2 quads freeze the game. After the fix: 2 quads appear
   at different positions in the headset.

2. **Edit mode per-widget movement** — enter edit mode (Ctrl+Shift+F9).
   Cycle to a widget (Space). Press arrow keys. Confirm the selected
   widget moves independently in the headset while others stay put.

3. **maxLayerCount respected** — check `irdashies-openxr-layer.log` for
   the `maxLayerCount` value. With 10 widgets, confirm we never append
   more than `maxLayerCount - gameLayerCount` quads.

4. **No freeze under load** — run a heavy iRacing session (full grid, high
   settings) with 5+ VR widgets in edit mode. Confirm no freeze, no frame
   drops beyond expected.

5. **Normal mode unaffected** — exit edit mode. Confirm the single full-atlas
   quad works as before (the consumer may need to destroy per-layer
   swapchains when switching from multi-quad to single-quad mode).

## References

- OpenXR spec on swapchain image lifecycle:
  https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html#swapchain-image-lifecycle
- `XrCompositionLayerQuad.subImage.imageArrayIndex`:
  https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html#XrSwapchainSubImage
- OpenKneeboard uses per-layer swapchains (each `OpenXRD3D11Kneeboard` layer
  has its own swapchain):
  https://github.com/OpenKneeboard/OpenKneeboard — `src/dll/OpenXRD3D11Kneeboard.cpp`
- D3D11 `CopySubresourceRegion` (for the simple blit approach):
  https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-copysubresourceregion