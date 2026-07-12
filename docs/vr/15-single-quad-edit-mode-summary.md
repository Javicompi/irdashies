# 15 — Single-quad VR edit mode: Implementation Summary

## What was implemented

A 2D atlas-positioning edit mode for VR overlays. Instead of per-widget 3D
quads (which caused OpenXR runtime freezes, documented in
`13-vr-edit-mode-implementation.md`), this approach positions widgets within
a single shared quad by moving them in the atlas texture (X/Y pixels) and
adjusting the shared quad distance (Z metres).

| Feature | Key | Behaviour |
|---|---|---|
| Enter/exit edit mode | Ctrl+Shift+F9 | Toggle; 800ms debounce prevents double-fire from keydown+keyup |
| Cycle selected widget | Space | Green `outline-2 outline-green-500` border on selected widget |
| Move selected (X/Y) | Arrow keys | 10px per press; clamped to atlas bounds `[0, atlasW-1]` |
| Adjust shared distance (Z) | Q/E | 0.01m per press; clamped to `[-4, -0.5]`; debounced 100ms `applyVrOverlaySettings` |
| Instructions panel | Auto | Fixed bottom-centre; shows X (px), Y (px), Z (m) live values |
| Position persistence | On exit (F9) | `vrAtlasX`/`vrAtlasY` per widget + `distance` in `generalSettings.vr` |

## Architecture

```
[Electron main process]
  Ctrl+Shift+F9 → toggleVrEditMode
  Space         → cycleSelectedWidget
  Arrow keys    → moveSelected(dx, dy, 0)  → notifyRenderer (React re-render)
  Q/E           → moveSelected(0, 0, dz)   → applyVrOverlaySettings → publishVrLayers
  Save on exit  → saveVrEditPositions → saveDashboard

[VR atlas page (React, OSR window)]
  VrAtlasContainer:
    - Live positioning from `notifyRenderer` CustomEvent `vr-edit-state`
    - Shelf-packing with left margin for auto-placed widgets
    - Green outline on selected widget
    - Instructions panel (VrEditInstructions)
  Communication: `webContents.executeJavaScript` + `CustomEvent`
    (bypasses `contextBridge.exposeInMainWorld` which failed silently)

[OpenXR consumer (UNCHANGED)]
  - Single quad, full atlas, shared pose — same as normal mode
```

## Why this approach

The original plan (`11-vr-edit-mode.md`) called for per-widget 3D quads in
edit mode. Activating this path caused the OpenXR runtime to freeze the game
(tested twice). The single-quad approach avoids the multi-quad consumer path
entirely while still giving the user independent per-widget positioning.

Key design decisions:

- **2D atlas coordinates instead of 3D metres for X/Y.** Widgets are flat info
  panels — they don't need independent depth/rotation. Moving them in the
  atlas texture is simpler and avoids the multi-quad freeze.
- **Shared Z for all widgets.** Matches the "one floating panel" mental model.
  The user adjusts the whole panel's distance, not per-widget depth.
- **`vrAtlasX`/`vrAtlasY` (pixels) instead of `vrPosition [x,y,z]` (metres).**
  The old `vrPosition` field never worked visually (multi-quad was inactive).
- **Atlas sized to display resolution.** Chromium OSR caps the framebuffer to
  the monitor resolution (confirmed by `coded=1920x1032` in logs). A larger
  atlas would waste GPU memory with no visual benefit.
- **IPC via `executeJavaScript` + `CustomEvent`.** The `contextBridge` pattern
  (`vrEditBridge`) failed silently — the exposed API was never available in the
  renderer.

## What's pending

1. **Centering / left-right balance.** Widgets currently shelf-pack with a
   200px left margin. The user reports more free space to the right than left.
   Fine-tuning the initial placement (or adding per-session position memory
   that doesn't reset on re-entry) is a follow-up.
2. **Per-widget Z.** The shared Z covers the MVP but per-widget depth was the
   original goal. Requires fixing the multi-quad consumer freeze first.
3. **Settings UI for `vrEnabled`.** The `vrEnabled` flag on `DashboardWidget`
   exists but has no toggle in the settings UI. All enabled widgets appear in
   VR by default (unchanged from before edit mode).
4. **Position persistence across app restarts.** Positions save to disk but
   the renderer ignores saved `vrAtlasX`/`vrAtlasY` on next load (always
   re-centers). This is intentional for the MVP — the centering logic
   conflicts with saved positions. A proper solution would track which
   positions were user-placed vs auto-packed.
