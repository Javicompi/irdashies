# 04 — One atlas + N per-widget quads (sub-rects)

## Problem

The current MVP renders the whole dashboard into a single OSR surface and
shows it as **one** quad (`src/app/vr/vrOverlay.ts`, `vr_overlay.cc`,
`layer.cpp`). The design doc's plan for multiple widgets is "one OSR
BrowserWindow per widget" (`vr-openxr-design.md:11`, `:51`). That is exactly
what the reviewer comment warns against:

> "1 OSR / overlay may not scale. It would be better to render all overlays in
> one page/one consumer, pack to one atlas, and split into per-widget quads
> with sub-rects on the consumer side."

N OSR surfaces = N Chromium compositors = N GPU contexts = does not scale, and
each pays the full per-frame OSR overhead.

## Goal

- **One** offscreen surface (the one we already have) renders every enabled VR
  widget, packed into a single atlas texture at known sub-rects.
- **One** shared texture crosses to the game (single fence, single ring slot).
- The consumer emits **N** `XrCompositionLayerQuad`s, each referencing the
  **same swapchain** but with a different `subImage.imageRect` (the widget's
  sub-rect in the atlas), its own pose, size, and opacity.

This is the OpenKneeboard model (`vr-website-rendering.md:53-56`: "Spriting
pack all layers into one texture atlas ... sub-image rect into swapchain
atlas"), applied to irDashies widgets instead of browser tabs.

## Approach (step by step)

### 1. Define the layer table in SHM

Extend `IrdashiesShmHeader` (alongside the ring from #01) with a per-layer
array. This replaces the single shared pose fields:

```c
#define IRDASHIES_SHM_MAX_LAYERS 16u

struct IrdashiesShmLayer {
  float posePosition[3];       // metres, LOCAL space
  float poseOrientation[4];    // quaternion x,y,z,w
  float quadSizeMeters[2];     // width, height
  float sourceRect[4];         // x, y, w, h in atlas texels
  float opacity;               // 0..1
  uint32_t visible;            // 0 = skip this layer
};
// in header:
uint32_t layerCount;                       // 0..MAX_LAYERS
IrdashiesShmLayer layers[IRDASHIES_SHM_MAX_LAYERS];
```

Keep `recenterCounter` (applies to all layers for MVP; per-layer recenter is a
later UX step).

### 2. Pack widgets into the atlas (app side)

Two viable packing strategies — pick one:

**A. A dedicated VR page in the renderer** (recommended): a new route/page
that lays out every VR-enabled widget at fixed atlas coordinates. The OSR
window loads **this** page instead of the desktop overlay. The page reports its
layout (widgetId → `sourceRect`) to the main process via IPC, which forwards it
to the native addon. Benefit: widget pixel layout is owned by React/Tailwind,
same code style as the rest of the app.

**B. Pack in the native addon**: the addon receives N widget textures and
copies them into atlas sub-rects. This requires N source textures → back to
the N-OSR problem. **Reject** unless widgets come from a single source.

So: **single OSR surface = the VR atlas page**. The page itself decides where
each widget lands. The main process reads the layout (e.g. the page posts it
over the existing dashboard bridge, or a dedicated `vr-layout` IPC) and passes
`LayerConfig[]` to `VrOverlayNative.setLayers(...)`.

Atlas size: use the supersample logic already in `vrOverlay.ts:69-76`, but
make the atlas a power-of-two-friendly rectangle (e.g. 2048x2048) and let the
page place widgets within it. The exact packing can be simple shelf/row
packing; the page just needs to know the final `sourceRect` per widget.

### 3. Producer publishes the layer table

`vr_overlay.cc` gains a `setLayers(LayerConfig[])` (mirrors `setPose`). On each
`submitFrame`, after copying the atlas texture into the ring slot, write
`shm->layerCount` and `shm->layers[]` under the mutex. Pose/size/sourceRect are
already in metres/texels; no GPU work.

### 4. Consumer emits N quads from one swapchain

In `my_xrEndFrame` (`layer.cpp:473`):

1. Read the frame + layer table.
2. `ensureSwapchain(frame.width, frame.height)` — **one** swapchain sized to
   the whole atlas (already the case).
3. Acquire/wait/release **once**, blit the whole atlas into the swapchain image
   once (single fullscreen-triangle draw — unchanged blit). The atlas is the
   unit of transfer; sub-rects are a composition-layer concern, not a render
   concern.
4. For each `layers[i]` with `visible != 0` and `i < layerCount`:
   ```c
   XrCompositionLayerQuad q{XR_TYPE_COMPOSITION_LAYER_QUAD};
   q.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
   q.space = g.localSpace;
   q.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
   q.subImage.swapchain = g.swapchain;          // SAME swapchain for all
   q.subImage.imageRect.offset.x = (int32_t)layers[i].sourceRect[0];
   q.subImage.imageRect.offset.y = (int32_t)layers[i].sourceRect[1];
   q.subImage.imageRect.extent.width  = (int32_t)layers[i].sourceRect[2];
   q.subImage.imageRect.extent.height = (int32_t)layers[i].sourceRect[3];
   q.subImage.imageArrayIndex = 0;
   q.pose.position = ...; q.pose.orientation = ...; q.size = ...;
   quads.push_back(q);
   ```
5. Append all quad headers to the game's layer list, respecting
   `maxLayerCount` (see #05). Call the real `xrEndFrame`.

Key point: `XrSwapchainSubImage::imageRect` is **exactly** the mechanism OpenXR
provides for "one texture, many quads". The runtime samples only that sub-rect
of the shared swapchain image for each quad. No per-widget swapchain, no
per-widget texture.

### 5. Settings → layer table

Wire `VrOverlaySettings` (per-widget) into the layer table. Each VR-enabled
widget contributes one `IrdashiesShmLayer` with its pose (from settings) and
its `sourceRect` (from the atlas page layout). When the user toggles a widget
on/off in VR, update `visible` and republish. This replaces the single
`poseFromSettings` in `vrOverlay.ts:35-46`.

### 6. Fallback

No producer / `layerCount == 0` → keep the current single-quad animated
fallback (`layer.cpp:552-560`) so there's always visible feedback.

## Code touch points

| File | Change |
| --- | --- |
| `native/shared/irdashies_shm.h` | `IrdashiesShmLayer[]` + `layerCount`. |
| `src/app/vr/native/vr_overlay.cc` | `setLayers`, publish layer table each frame. |
| `src/app/vr/native/index.d.ts` | `setLayers(layers: LayerConfig[]): void`. |
| `src/app/vr/vrOverlay.ts` | Load the VR atlas page instead of the desktop overlay; read layout; call `setLayers`. |
| `src/frontend/components/` | New VR atlas page/route (or reuse existing widgets in a fixed-layout container). |
| `native/openxr-layer/src/layer.cpp` | Loop over `layers[]`, emit N quads from one swapchain. |
| `native/shm-test-producer/src/producer.cpp` | Render N coloured rectangles at known sub-rects + publish a layer table (test harness). |

## References

- OpenKneeboard "Spriting" + `LayerConfig.mLocationOnTexture`
  (`vr-website-rendering.md:34`, `:53-56`):
  https://github.com/OpenKneeboard/OpenKneeboard — `src/dll/SHM.h` (`LayerConfig`)
  and `InterprocessRenderer.cpp` (composites tabs into one canvas with per-tab
  `mLocationOnTexture`).
- OpenXR `XrSwapchainSubImage::imageRect` (sub-rect sampling from a shared
  swapchain): https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html#XrSwapchainSubImage
- Reviewer comment quoted in the task: "render all overlays in one page/one
  consumer, pack to one atlas, and split into per-widget quads with sub-rects
  on the consumer side."

## How to test

1. **Test-producer multi-quad (no headset, then headset)** — extend the test
   producer to:
   - Render a 1024x1024 atlas with 4 coloured quadrants (red TL, green TR,
     blue BL, yellow BR).
   - Publish `layerCount = 4` with `sourceRect`s matching each quadrant and
     distinct poses (e.g. front-left, front-right, low-left, low-right).
   - In-headset: confirm **4 separate quads** appear at the 4 poses, each
     showing **only** its quadrant colour (no bleed from neighbours). This
     proves `imageRect` sub-sampling works end to end.
2. **Probe assertion (no headset)** — `irdashies-shm-probe` reads
   `layerCount` and each layer's `sourceRect`; assert they tile the atlas
   without overlap (or with the intended overlap).
3. **maxLayerCount cap** — with #05 applied, run a producer that publishes
   more layers than the runtime's `maxLayerCount`; confirm the consumer drops
   the excess (oldest/lowest-priority first) and still calls `xrEndFrame`
   successfully (no error, no crash).
4. **Scale test** — publish 1 vs 8 vs 16 layers. Measure: the producer cost
   should be ~constant (one atlas copy, one fence signal — layer count is just
   a few hundred bytes of SHM). The consumer cost grows only with the number
   of `XrCompositionLayerQuad` structs appended (trivial). This is the whole
   point: O(1) texture work, O(N) cheap composition layers, **not** O(N) OSR
   surfaces.
5. **Widget toggle** — in the real app, toggle a widget's VR visibility; the
   quad appears/disappears within one or two frames with no atlas rebuild.
