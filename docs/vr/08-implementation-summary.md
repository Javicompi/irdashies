# irDashies VR — Implementation Summary

Summary of the 7 optimisation changes from `docs/vr/00..07`, what was
implemented, and what remains.

## Implemented changes

| #  | Change                     | Phase | Branch                              | Notes |
| -- | -------------------------- | ----- | ------------------------------------ | ----- |
| 03 | iRacing process gate       | 0     | `feat/iracing-process-gate`          | Docs: [03-iracing-process-gate.md](./03-iracing-process-gate.md) |
| 02 | Format match / swizzle     | 0     | `feat/format-match-swizzle`          | Docs: [02-format-match-swizzle.md](./02-format-match-swizzle.md) |
| 01 | Triple-buffer ring         | 1     | `feat/triple-buffer-ring`            | Docs: [01-triple-buffer-ring.md](./01-triple-buffer-ring.md) |
| 04 | Atlas + N per-widget quads | 2     | `feat/atlas-multi-quad`              | Docs: [04-atlas-multi-quad.md](./04-atlas-multi-quad.md) |
| 05 | maxLayerCount + reuse      | 2     | `feat/maxlayercount-vector-reuse`    | Docs: [05-maxlayercount-vector-reuse.md](./05-maxlayercount-vector-reuse.md) |
| 07 | Skip redundant frame work  | 3     | `feat/skip-redundant-frame-work`     | Docs: [07-skip-redundant-frame-work.md](./07-skip-redundant-frame-work.md) |
| 06 | Device/context robustness  | 4     | `feat/device-context-robustness`     | Docs: [06-dedicated-device-robustness.md](./06-dedicated-device-robustness.md) |

The implementation order mostly followed
[00-implementation-order.md](./00-implementation-order.md). Dependencies were
respected: #01 (SHM v2 bump) was done before #04 and #07 so the contract only
changed once; #04 was done before #05 so the N-quad loop was only rewritten
once.

## Gaps from the original plan

### #04 — VR atlas page / frontend layout (deferred)

The native infrastructure is complete:

- `IrdashiesShmLayer[]` table reserved in the SHM v2 header.
- Producer `setLayers()` accepts per-widget `LayerConfig` (pose, size,
  `sourceRect`, opacity, visible).
- Consumer builds N `XrCompositionLayerQuad` from the layer table, each with
  its own `subImage.imageRect` (sub-rect in the atlas), pose, size, and
  opacity.

What was **not** implemented (to be done in a follow-up PR):

- A dedicated VR atlas page in the renderer (React route) that packs VR-enabled
  widgets at fixed atlas coordinates and reports the layout to the main process
  via IPC.
- Per-widget VR enable/disable (the current code publishes a single layer
  covering the full atlas, so visual behaviour is unchanged from the pre-atlas
  build).
- Per-widget VR pose settings (the shared-pose fallback is still used as the
  default when the layer table has no entries).

See `docs/vr/04-atlas-multi-quad.md` sections 2 and 5 for the planned approach.

### #06 — Fallback clear path (removed)

The doc suggests routing the no-producer fallback clear through the deferred
context. This fallback (an animated blue pulse) was **removed** entirely; when
no producer is connected the layer passes through `xrEndFrame` unmodified.
There is no frame work to route. If the fallback is reintroduced later it
should use the deferred context.

### #05 — `xrGetSystemProperties` not always available

The runtime may not expose `xrGetSystemProperties` to API layers. The fallback
sets `maxLayerCount = 1` as a safe default. The budget logic in the consumer
works correctly regardless.

## Deviations / improvements over the original plan

1. **No-producer pass-through.** The animated blue fallback was removed.
   When the producer is not running the layer is a pure pass-through — no
   swapchain, no quad, zero overhead. This is cleaner behaviour and avoids
   the distracting pulse when irDashies isn't open.

2. **`sourceRect` clamping.** The consumer clamps each layer's `sourceRect`
   to the swapchain dimensions (`std::min`). This prevents the OpenXR runtime
   from sampling beyond swapchain bounds when the OSR window size temporarily
   differs from the painted `visibleRect` (Chromium padding).

3. **Per-layer recenter.** The recenter transform (yaw + anchor point) is
   applied to every quad built from the layer table, not only the shared-pose
   fallback. Each widget recenters independently with the same head-pose
   anchor.

4. **Cache invalidation on producer restart.** The `lastConsumedSlot` cache
   from #07 is invalidated when the producer PID or a slot's texture handle
   changes, preventing stale SRV use after a producer restart.

5. **`CreateDeferredContext` failure is fatal.** The original code logged a
   warning and fell back to the game's immediate context. The layer now refuses
   to activate if a deferred context cannot be created, guaranteeing the game's
   pipeline state is never disturbed.

6. **SHM v2 reserves the layer table.** The header was designed in #01 with
   `IrdashiesShmLayer layers[IRDASHIES_SHM_MAX_LAYERS]` already allocated so
   #04 was additive and did not force a second version bump.

## Future work

- **VR atlas page** — render all VR-enabled widgets into a single React page at
  fixed atlas coordinates; report layout to the main process via IPC; call
  `setLayers()` with per-widget `sourceRect` values.
- **Per-widget VR settings** — toggle VR visibility per widget; independent
  pose/size per widget.
- **In-headset repositioning** — OpenXR action sets for motion-controller or
  gaze-based quad dragging (the biggest UX improvement).
- **Opacity** — the `opacity` field is in the SHM contract and published by the
  producer, but the consumer does not yet read it (the blit shader copies texels
  as-is, and OpenXR has no quad-level opacity control). Implementing it requires:
  a per-layer blit with a scissor rect set to the layer's `sourceRect`, passing
  `opacity` as a shader constant, multiplying `rgb * opacity` and `a * opacity`
  in the pixel shader (Chromium OSR textures are premultiplied, so both must be
  scaled). Keep `BLEND_TEXTURE_SOURCE_ALPHA_BIT` since we premultiply in-shader.
  Deferred to the atlas-page follow-up where the opacity UI lands with it.
- **Test harness** — a standalone OpenXR host app (like Khronos `hello_xr`)
  configured to load the layer would allow validating the full pipeline
  without launching iRacing each iteration.
