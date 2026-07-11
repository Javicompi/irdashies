# 13 — VR Edit Mode: Implementation Summary

## What was implemented vs the original plan (`11-vr-edit-mode.md`)

| Feature | Planned | Implemented | Notes |
|---|---|---|---|
| F9 toggle edit mode | Yes | Yes (Ctrl+Shift+F9) | F9 captured by iRacing at low level |
| Green border on selected widget | Yes | Yes | `outline-2 outline-green-500` |
| Instructions panel with controls + X/Y/Z | Yes | Yes | `VrEditInstructions` renders in atlas |
| Cycle widgets (Space) | Yes | Yes | Green border moves between widgets |
| Move selected (arrows, Q/E) | Yes | Yes (values update in panel) | **No visual quad movement** (see below) |
| Per-widget quads in edit mode | Yes | **No** | Single full-atlas quad in both modes |
| Per-widget pose saved on exit | Yes | Yes | `vrPosition` persisted to dashboard JSON |
| Visual widget repositioning in headset | Yes | **No** | Positions saved but quad doesn't move visually |

## Why per-widget quads are not active

The original plan (`11-vr-edit-mode.md:585-623`) calls for publishing N per-widget
quads (one per VR widget + one for the instructions panel) in edit mode. The
infrastructure exists (`setLayers`, `IrdashiesShmLayer[]`, consumer N-quad loop
from `#04`), but activating it causes the OpenXR runtime to **freeze the game**
(tested twice).

The root cause is not yet identified. Possible suspects:

- **`maxLayerCount` exceeded.** The game may use several composition layers
  already. Adding N+1 overlay quads pushes the total over the runtime's limit.
  The budget code (from `#05`) should prevent this, but may have a subtle bug.
- **Invalid `sourceRect` values.** Per-widget sub-rects may not align with the
  swapchain dimensions when the OSR window size differs from the painted
  `visibleRect`.
- **Fence/wait issue.** Multiple quads referencing the same swapchain may
  trigger a GPU fence wait that never completes.

The workaround: publish a single full-atlas quad in both normal and edit mode.
The edit-mode UI (green borders, instructions panel) is rendered **into the
atlas texture** by React via `VrAtlasContainer`. This gives the user all the
edit-mode controls without touching the multi-quad consumer path.

## What was built differently

1. **IPC mechanism.** The `vrEditBridge` via `contextBridge.exposeInMainWorld`
   was replaced with `webContents.executeJavaScript` + `CustomEvent`
   (`vr-edit-state`). The `contextBridge` approach failed silently (the exposed
   API was never available in the renderer, likely due to `ipcRenderer.on`
   incompatibility with `contextBridge` in this Electron version).

2. **Widget distribution on entry.** The planned spread-out default positions
   (vertical offset per widget) were removed because they're not visible
   without per-widget quads. Widgets default to the global VR pose position.

3. **Keyboard shortcut.** `F9` was changed to `Ctrl+Shift+F9` because iRacing
   captures bare F9 at the DirectInput level before Electron's
   `globalShortcut` can see it. The log shows `F9 pressed` because
   `globalShortcut` reports the base key even when modifiers are held.

4. **Hide/show fix.** `VrAtlasApp` was missing `<HideUIWrapper>`, which caused
   `Alt+H` (toggle-hide-ui) to be ignored in VR. Fixed by wrapping
   `VrAtlasContainer` in `<HideUIWrapper>` (matching `OverlayApp`).

## Next steps

1. **Debug multi-quad consumer freeze.** Investigate why publishing multiple
   quads from the layer table causes the OpenXR runtime to hang. Reproduce
   with 2-3 simple quads (no complex `sourceRect`s). Check `maxLayerCount`
   budget logic, fence values, and swapchain dimensions.

2. **Activate per-widget quads in edit mode.** Once the consumer freeze is
   fixed, revert `publishVrLayers` to the per-widget path from the original
   plan. Each widget gets its own quad with `vrPosition` pose.

3. **Visual movement during edit.** With per-widget quads active, arrow keys
   and Q/E will visibly move the selected widget in the headset in real time.
