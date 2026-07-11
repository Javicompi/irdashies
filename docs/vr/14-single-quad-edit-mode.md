# 14 — Single-quad VR edit mode (2D atlas positioning)

## Goal

Let the user position each VR overlay **independently** within a single shared
quad, using keyboard shortcuts from inside the headset. No per-widget 3D quads,
no changes to the OpenXR consumer, no risk of the multi-quad freeze documented
in `13-vr-edit-mode-implementation.md`.

This is the OpenKneeboard model: one floating "panel" in 3D space, with each
widget positioned freely within it. The user adjusts each widget's 2D position
(X/Y) within the atlas texture; the shared quad's distance (Z) is adjusted
globally for all widgets at once.

## What the user sees

- A single semi-transparent panel floating in front of them in VR.
- Each enabled widget (standings, fuel, input, etc.) is rendered at a
  user-defined position within that panel.
- On entering edit mode (Ctrl+Shift+F9), the selected widget gets a green
  border. Arrow keys move it within the panel. Q/E move the whole panel
  closer/farther.
- The instructions overlay shows the current X/Y (pixels) and Z (metres).

## Limitations (acceptable)

| Limitation | Impact | Why it's acceptable |
| --- | --- | --- |
| All widgets share one Z (distance) | No per-widget depth/parallax | OpenKneeboard works this way; a dashboard doesn't need 3D depth between widgets |
| All widgets share one quad size (metres) | Panel scales as a unit | Consistent with "one floating panel" mental model |
| Per-widget positioning is 2D (atlas pixels) | No 3D rotation per widget | Widgets are flat info panels, not 3D objects |
| `vrPosition` is now `[x, y]` (atlas pixels), not `[x, y, z]` (metres) | Breaks any saved `[x,y,z]` positions | Those positions never worked visually anyway (multi-quad was never active) |

## How it works

```
[Electron main process]
  Ctrl+Shift+F9 → toggle vrEditMode
  Space         → cycle selectedWidgetId
  Arrow keys    → update selected widget's vrAtlasX / vrAtlasY (pixels)
  Q / E         → update VrOverlaySettings.distance (metres, shared)
                  → applyVrOverlaySettings → publishVrLayers (shared quad pose)
  Save on exit  → saveDashboard with vrAtlasX/vrAtlasY per widget + distance in generalSettings

[VR atlas page (React, OSR window)]
  VrAtlasContainer:
    - Reads vrAtlasX/vrAtlasY from each widget's config
    - Renders each widget at [vrAtlasX, vrAtlasY] (absolute, not shelf-packed)
    - Green outline on selectedWidgetId when editMode
    - VrEditInstructions panel (fixed bottom-centre)

[OpenXR consumer (UNCHANGED)]
  - Single quad, full atlas, shared pose — exactly what works today
```

---

## Step-by-step implementation

### 1. Change `vrPosition` to `vrAtlasX` / `vrAtlasY`

**File:** `src/types/dashboardLayout.ts`

Replace the existing `vrPosition` field with per-widget 2D atlas coordinates:

```typescript
export interface DashboardWidget {
  // ... existing fields ...
  /**
   * Per-widget position within the VR atlas texture (pixels from top-left).
   * When absent, the widget is auto-placed by shelf packing. Set by the user
   * via VR edit mode.
   */
  vrAtlasX?: number;
  vrAtlasY?: number;
  // ... existing fields ...
}
```

Remove the old `vrPosition?: [number, number, number]` field. Any saved
`vrPosition` values from the multi-quad experiment never worked visually, so
no migration is needed — the auto-pack fallback handles it.

### 2. Atlas size: large enough for free placement

**File:** `src/app/vr/vrOverlay.ts`

The atlas texture size is currently the display size × supersample, capped at
2048 (`vrOverlay.ts:113-122`). This works but is tied to the monitor
resolution. For VR free-placement, the atlas should be a **fixed large canvas**
independent of the display, so the user has room to spread widgets out.

Change the atlas dimensions to fixed values:

```typescript
// Fixed VR atlas size — large enough for ~20 widgets with room to spare.
// 3840×2160 (4K) is a good balance: plenty of space, well under the 4096
// runtime swapchain limit, and the GPU copy cost is ~33MB/frame at 60fps
// which is negligible (<3% of a modern GPU's bandwidth).
const VR_ATLAS_WIDTH = 3840;
const VR_ATLAS_HEIGHT = 2160;
```

In `startVrOverlay`, replace the display-based sizing:

```typescript
// Before:
const { width: displayW, height: displayH } = screen.getPrimaryDisplay().size;
let scale = Math.min(VR_SUPERSAMPLE, VR_MAX_TEXTURE_DIM / Math.max(displayW, displayH));
// ...

// After:
const texW = VR_ATLAS_WIDTH;
const texH = VR_ATLAS_HEIGHT;
const zoomFactor = 1;  // no supersample zoom needed with a fixed large atlas
```

Remove `VR_SUPERSAMPLE` and `VR_MAX_TEXTURE_DIM` constants (no longer used).

Update `atlasTexW`/`atlasTexH`:
```typescript
let atlasTexW = VR_ATLAS_WIDTH;
let atlasTexH = VR_ATLAS_HEIGHT;
```

The OSR window is created at `texW × texH` — Chromium renders the atlas page at
3840×2160. The `window.innerWidth` in React matches this (3840), so widgets
have room to be placed anywhere in a 4K canvas.

**Performance note**: 3840×2160 BGRA = ~33 MB per frame. The GPU copy
(`CopySubresourceRegion`) is a single sequential write — negligible on any
modern GPU. The Chromium compositing cost is higher than 1080p, but the VR
overlay only renders enabled widgets (no settings, no edit-mode chrome), so
the actual dirty region is small. If perf is a concern, 2560×1440 (1440p, ~15
MB/frame) is a safe fallback — still plenty of space.

### 3. Widget placement in React (absolute positioning)

**File:** `src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx`

Replace the shelf-packing with absolute positioning. If a widget has
`vrAtlasX`/`vrAtlasY`, use them. Otherwise, shelf-pack as a fallback (first
time, before the user enters edit mode).

```tsx
const slots = useMemo<AtlasSlot[]>(() => {
  const result: AtlasSlot[] = [];
  let fallbackX = 0, fallbackY = 0, rowH = 0;
  const padding = 4;
  const atlasWidth = window.innerWidth;

  for (const w of vrWidgets) {
    const ww = w.layout.width;
    const wh = w.layout.height;
    if (w.vrAtlasX != null && w.vrAtlasY != null) {
      // User-placed: use saved position.
      result.push({ widgetId: w.id, x: w.vrAtlasX, y: w.vrAtlasY, width: ww, height: wh });
    } else {
      // Auto-pack fallback (first run, before edit mode).
      if (fallbackX + ww > atlasWidth && fallbackX > 0) {
        fallbackX = 0;
        fallbackY += rowH + padding;
        rowH = 0;
      }
      result.push({ widgetId: w.id, x: fallbackX, y: fallbackY, width: ww, height: wh });
      fallbackX += ww + padding;
      rowH = Math.max(rowH, wh);
    }
  }
  return result;
}, [vrWidgets]);
```

The render path is unchanged — `WidgetContainer` receives
`layout: { x: slot.x, y: slot.y, width, height }`, same as now.

### 4. Edit mode: X/Y moves the widget in atlas pixels

**File:** `src/app/vr/vrOverlay.ts`

Change the edit-mode state from 3D metres to 2D pixels + shared Z:

```typescript
// VR edit-mode state.
let vrEditMode = false;
let selectedWidgetIndex = 0;
let selectedWidgetId: string | null = null;
// X/Y are atlas pixels; Z is the shared distance (metres, negative).
let liveEditX = 0;
let liveEditY = 0;
let liveEditZ = -1.5;
```

Replace `getWidgetVrPosition` with simpler helpers:

```typescript
function getWidgetAtlasPos(widgetId: string): [number, number] {
  const widget = currentDashboard?.widgets.find((w) => w.id === widgetId);
  return [widget?.vrAtlasX ?? 0, widget?.vrAtlasY ?? 0];
}

function getSharedDistance(): number {
  return -(currentVrPose?.position?.[2] ?? DEFAULT_POSE.position[2]);
}
```

### 5. Move handler: arrows = X/Y pixels, Q/E = shared Z

```typescript
function moveSelected(dx: number, dy: number, dz: number): void {
  if (!vrEditMode || !selectedWidgetId) return;

  if (dx !== 0 || dy !== 0) {
    // X/Y: per-widget atlas pixels (10px per press — adjustable)
    liveEditX = Math.max(0, Math.min(liveEditX + dx, atlasTexW - 1));
    liveEditY = Math.max(0, Math.min(liveEditY + dy, atlasTexH - 1));
    notifyRenderer();
    // No publishVrLayers needed — the widget moves in the atlas texture,
    // which React re-renders. The quad pose doesn't change.
  }

  if (dz !== 0) {
    // Z: shared distance (metres). 0.01m per press.
    liveEditZ = Math.max(-4, Math.min(liveEditZ + dz, -0.5));
    // Update the shared VR settings so the quad moves.
    // This calls applyVrOverlaySettings → publishVrLayers internally
    // via the onDashboardUpdated listener, OR we can call it directly.
    const settings: VrOverlaySettings = {
      ...DEFAULT_VR_OVERLAY_SETTINGS,
      width: currentVrPose?.size?.[0] ?? DEFAULT_POSE.size[0],
      distance: -liveEditZ,
      horizontal: currentVrPose?.position?.[0] ?? 0,
      vertical: currentVrPose?.position?.[1] ?? 0,
    };
    applyVrOverlaySettings(settings);
    notifyRenderer();
  }
}
```

Register the keys with pixel step:

```typescript
function registerEditKeys(): void {
  if (editKeysRegistered) return;
  editKeysRegistered = true;
  const reg = (accel: string, handler: () => void) => {
    if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
    globalShortcut.register(accel, handler);
  };
  const PX = 10;  // pixels per arrow press
  reg('Space', () => cycleSelectedWidget());
  reg('Left',  () => moveSelected(-PX, 0, 0));
  reg('Right', () => moveSelected( PX, 0, 0));
  reg('Up',    () => moveSelected(0, -PX, 0));   // up arrow = up (lower Y)
  reg('Down',  () => moveSelected(0,  PX, 0));   // down arrow = down (higher Y)
  reg('Q',     () => moveSelected(0, 0, -0.01));  // closer (z more negative)
  reg('E',     () => moveSelected(0, 0,  0.01));  // farther
}
```

Note: in screen coordinates, Y increases downward. Up arrow decreases Y (moves
widget up), Down arrow increases Y (moves widget down). This matches natural
expectation.

### 6. Toggle edit mode and cycle

```typescript
function toggleVrEditMode(): void {
  logger.info('[VR] edit mode toggle (osrWindow=%s)', osrWindow ? 'exists' : 'null');
  if (!osrWindow || osrWindow.isDestroyed()) return;
  vrEditMode = !vrEditMode;

  if (vrEditMode) {
    selectedWidgetIndex = 0;
    selectedWidgetId = atlasLayout[0]?.widgetId ?? null;
    if (selectedWidgetId) {
      const [x, y] = getWidgetAtlasPos(selectedWidgetId);
      liveEditX = x; liveEditY = y;
      liveEditZ = -getSharedDistance();
    }
    registerEditKeys();
    logger.info('[VR] edit mode ON');
  } else {
    unregisterEditKeys();
    saveVrEditPositions();
    selectedWidgetId = null;
    logger.info('[VR] edit mode OFF');
  }

  notifyRenderer();
  publishVrLayers();
}

function cycleSelectedWidget(): void {
  if (!vrEditMode || atlasLayout.length === 0) return;
  commitLivePositionToDashboard();
  selectedWidgetIndex = (selectedWidgetIndex + 1) % atlasLayout.length;
  selectedWidgetId = atlasLayout[selectedWidgetIndex].widgetId;
  if (selectedWidgetId) {
    const [x, y] = getWidgetAtlasPos(selectedWidgetId);
    liveEditX = x; liveEditY = y;
    liveEditZ = -getSharedDistance();
  }
  notifyRenderer();
}
```

### 7. Notify renderer (IPC → React state)

Update `notifyRenderer` to send X/Y (pixels) + Z (metres):

```typescript
function notifyRenderer(): void {
  if (!osrWindow || osrWindow.isDestroyed()) return;
  osrWindow.webContents.executeJavaScript(
    `window.__vrEdit={active:${vrEditMode},id:'${selectedWidgetId ?? ''}',` +
    `x:${liveEditX},y:${liveEditY},z:${liveEditZ}};` +
    `window.dispatchEvent(new CustomEvent('vr-edit-state',{detail:window.__vrEdit}));`
  ).catch(() => {});
}
```

### 8. Save positions on exit

```typescript
function commitLivePositionToDashboard(): void {
  if (!currentDashboard || !selectedWidgetId) return;
  currentDashboard = {
    ...currentDashboard,
    widgets: currentDashboard.widgets.map((w) =>
      w.id === selectedWidgetId
        ? { ...w, vrAtlasX: liveEditX, vrAtlasY: liveEditY }
        : w
    ),
  };
}

function saveVrEditPositions(): void {
  commitLivePositionToDashboard();
  if (!currentDashboard) return;
  // Also persist the shared Z (distance) into generalSettings.vr.
  const z = -liveEditZ;
  const vrSettings: VrOverlaySettings = {
    ...DEFAULT_VR_OVERLAY_SETTINGS,
    width: currentVrPose?.size?.[0] ?? DEFAULT_POSE.size[0],
    distance: z,
    horizontal: currentVrPose?.position?.[0] ?? 0,
    vertical: currentVrPose?.position?.[1] ?? 0,
  };
  currentDashboard = {
    ...currentDashboard,
    generalSettings: { ...currentDashboard.generalSettings, vr: vrSettings },
  };
  saveDashboard(getCurrentProfileId(), currentDashboard);
}
```

### 9. Update VrEditInstructions (display X/Y/Z)

**File:** `src/frontend/components/VrAtlasContainer/VrEditInstructions.tsx`

Change the state and display:

```tsx
export const VrEditInstructions = memo(() => {
  const [pos, setPos] = useState({ x: 0, y: 0, z: -1.5 });

  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as { x: number; y: number; z: number };
      setPos({ x: d.x ?? 0, y: d.y ?? 0, z: d.z ?? -1.5 });
    };
    window.addEventListener('vr-edit-state', handler);
    return () => window.removeEventListener('vr-edit-state', handler);
  }, []);

  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[9999]
                    bg-slate-900/95 border border-slate-600/25 rounded
                    px-8 py-5 text-white font-sans pointer-events-none"
         style={{ minWidth: '440px' }}>
      <div className="flex flex-col gap-2 mb-3">
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Ctrl+Shift+F9</span>
          <span className="text-white/75">Exit edit mode</span>
        </div>
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Space</span>
          <span className="text-white/75">Cycle overlay</span>
        </div>
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Arrow keys</span>
          <span className="text-white/75">Move overlay (X / Y)</span>
        </div>
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Q / E</span>
          <span className="text-white/75">Distance — all overlays (Z)</span>
        </div>
      </div>
      <div className="flex items-baseline justify-between text-sm pt-3 border-t border-slate-600/20">
        <span className="font-bold text-slate-300">Position</span>
        <div className="flex gap-6">
          <span className="font-bold text-green-400 tabular-nums min-w-[80px] text-center">
            X: {pos.x.toFixed(0)}px
          </span>
          <span className="font-bold text-green-400 tabular-nums min-w-[80px] text-center">
            Y: {pos.y.toFixed(0)}px
          </span>
          <span className="font-bold text-green-400 tabular-nums min-w-[80px] text-center">
            Z: {pos.z.toFixed(2)}m
          </span>
        </div>
      </div>
    </div>
  );
});
VrEditInstructions.displayName = 'VrEditInstructions';
```

Key changes:
- `Q / E` label now says "Distance — all overlays (Z)" to make clear it's shared.
- X/Y display in pixels (`px`), Z in metres (`m`).

### 10. Update VrAtlasContainer edit-state handler

**File:** `src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx`

Update the event handler to match the new shape:

```tsx
const handler = (e: Event) => {
  const d = (e as CustomEvent).detail as { active: boolean; id: string; x: number; y: number; z: number };
  setEditMode(d.active);
  setSelectedWidgetId(d.id || null);
  // No need to store x/y/z here — VrEditInstructions has its own listener.
};
```

Remove the `setLivePosition` state (no longer needed in `VrAtlasContainer` —
the green border only needs `selectedWidgetId`, and the instructions panel reads
its own values from the same event).

### 11. `publishVrLayers` — unchanged

`publishVrLayers` stays exactly as it is now: a single full-atlas quad with the
shared pose. The consumer never sees multiple layers. The only thing that
changes during edit mode is:
- React renders widgets at their `vrAtlasX`/`vrAtlasY` positions (moved by
  arrows) → the atlas texture contains the new layout → the consumer blits it
  as one quad.
- Q/E updates `VrOverlaySettings.distance` → `applyVrOverlaySettings` updates
  the shared pose → `publishVrLayers` sends the new quad position.

No `publishVrLayers` change needed for X/Y arrow movements — the atlas texture
is repainted by React on the next `paint` event, and the consumer picks it up
on the next frame.

---

## Code touch points

| File | Change |
| --- | --- |
| `src/types/dashboardLayout.ts` | Replace `vrPosition?: [number,number,number]` with `vrAtlasX?: number` + `vrAtlasY?: number` |
| `src/app/vr/vrOverlay.ts` | Fixed atlas size (3840×2160); edit state X/Y pixels + Z metres; `moveSelected` separates X/Y (per-widget atlas) from Z (shared settings); `saveVrEditPositions` persists both |
| `src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx` | Absolute positioning from `vrAtlasX`/`vrAtlasY` (fallback: shelf-pack); event handler shape update |
| `src/frontend/components/VrAtlasContainer/VrEditInstructions.tsx` | Display X (px), Y (px), Z (m); Q/E label says "all overlays" |

**No changes to:**
- `native/openxr-layer/src/layer.cpp` (consumer)
- `native/shared/irdashies_shm.h` (SHM contract)
- `src/app/vr/native/vr_overlay.cc` (producer addon)
- `native/openxr-layer/src/layer.cpp` (consumer)

---

## Atlas size and performance

| Aspect | Value | Rationale |
| --- | --- | --- |
| Atlas dimensions | 3840 × 2160 | 4K gives ~8M pixels of canvas; a typical widget is 300×200px, so 40+ widgets fit with room. Well under the 4096 runtime swapchain limit. |
| Frame size | ~33 MB (BGRA) | Single `CopySubresourceRegion` per frame — negligible on modern GPUs (<3% bandwidth). |
| Chromium compositing | Dirty-region only | Only changed widgets trigger repaint; the rest of the atlas is static. |
| OSR `paint` frequency | 60 Hz | Same as now; the atlas size doesn't change the frame rate. |
| Supersample | Removed | The atlas is already 4K; no need to supersample a 1080p layout. The `zoomFactor` is 1.0. |

If performance is a concern on lower-end GPUs, 2560×1440 (1440p, ~15 MB/frame)
is a safe fallback. It still fits 20+ widgets with comfortable spacing. Make
the dimensions a constant that's easy to tune.

---

## How to test

1. **Default placement** — start VR with 3+ enabled widgets, no saved
   `vrAtlasX`/`vrAtlasY`. Confirm widgets appear shelf-packed in the atlas
   (fallback layout, same as current).

2. **Enter edit mode** — press Ctrl+Shift+F9. Confirm green border on first
   widget, instructions panel visible, X/Y/Z values showing.

3. **Move a widget (X/Y)** — press arrow keys. Confirm:
   - The selected widget moves within the atlas (visible in the headset as the
     widget repositioning within the floating panel).
   - X/Y values update in the instructions panel (pixels).
   - Other widgets stay in place.
   - **No `publishVrLayers` call needed** — the movement is in the React
     render, picked up by the next `paint` event.

4. **Move all (Z)** — press Q/E. Confirm:
   - The entire panel moves closer/farther in the headset.
   - Z value updates (metres).
   - All widgets move together (shared distance).

5. **Cycle** — press Space. Confirm green border moves to next widget. X/Y
   values update to the newly selected widget's position.

6. **Exit and save** — press Ctrl+Shift+F9. Confirm:
   - Green border and instructions disappear.
   - Widgets stay at their new positions.
   - Dashboard JSON has `vrAtlasX`/`vrAtlasY` per widget and `distance` in
     `generalSettings.vr`.

7. **Restart** — quit and relaunch. Confirm widgets appear at their saved
   atlas positions (not shelf-packed).

8. **Z persisted** — change Z in edit mode, exit, restart. Confirm the panel
   is at the saved distance.

9. **No freeze** — run a heavy iRacing session with 10+ widgets in edit mode.
   Confirm no freeze, no crash, no frame drops (the consumer does exactly
   what it does today — one quad, one blit).

10. **Settings panel coexists** — open the VR settings page (desktop). Change
    distance. Confirm the overlay moves in the headset (the settings change
    flows through `applyVrOverlaySettings` → `publishVrLayers`, same as edit
    mode's Q/E). The two paths (settings panel + edit mode) must not conflict
    — last write wins.