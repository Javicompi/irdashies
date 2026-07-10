# irDashies VR — Performance: eliminate double rendering

The OpenXR pipeline itself (ring buffer, fence, blit, skip-redundant-work) is
as lean as it can be within the OpenXR + Chromium OSR architecture. The two
remaining performance levers are **architectural**: they reduce what runs
**above** the pipeline, not the pipeline itself.

## The problem

`src/app/vr/vrOverlay.ts:120` registers the OSR window as an external broadcast
target via `overlayManager.addExternalWindow(osrWindow)`. This does **not**
stop the desktop overlay windows. Result while VR is active:

1. **Desktop overlay windows** (one per display) — full React app, all stores,
   all telemetry subscriptions, Chromium compositing.
2. **VR OSR window** — the **same** full React app, the **same** stores, the
   **same** telemetry, the **same** compositing, rendered offscreen at up to
   2048×1152 supersampled.

iRacing is already GPU-bound. Running the irDashies dashboard twice — two
Chromium compositors, two React reconciliation passes at 60 Hz, two sets of
Zustand store subscriptions firing on every telemetry tick — costs several FPS
in the sim. This is the single biggest performance win available.

Additionally, the OSR window loads the **entire** renderer (`vrOverlay.ts:174`),
including settings routes, edit-mode logic, UI chrome, and widgets the user
doesn't want in VR. Every enabled widget subscribes to telemetry it may not
need for VR.

## Two changes

| #  | Change                              | Impact | Effort  |
| -- | ----------------------------------- | ------ | ------- |
| P1 | VR-only mode (suppress desktop)     | high   | low     |
| P2 | Dedicated VR atlas page             | medium | high    |

P1 is the high-ROI quick win. P2 is the larger architectural change that the
`08-implementation-summary.md` "Future work" already calls for; this doc fills
in the performance angle and the implementation detail.

---

## P1 — VR-only mode: suppress desktop overlays while VR is active

### Goal

When VR is active, close (or hide) the desktop overlay windows so the dashboard
is rendered **once** (in the OSR window). The settings window stays available.
When VR stops, recreate the desktop overlays.

### Why this works

The desktop overlay windows exist to show widgets on the physical monitor while
iRacing runs. When the user is in a headset, those windows are invisible to
them (the headset covers their eyes) and their rendering is pure waste. The OSR
window already receives all the same broadcasts (`addExternalWindow`) and
renders the same widgets, so closing the desktop windows loses nothing the user
can see.

### Step by step

#### 1. Add methods to `OverlayManager`

`src/app/overlayManager.ts` already has `closeAllOverlays()` (`:643`) and
`createOverlays(dashboard)` (`:80`). Add a pair that the VR lifecycle can call:

```typescript
/**
 * Close all display overlay windows but remember the dashboard so they can be
 * restored. Used when switching to VR-only mode.
 */
public suppressDesktopOverlays(): void {
  this.closeAllOverlays();
  logger.info('[OverlayManager] Desktop overlays suppressed (VR-only mode).');
}

/**
 * Recreate display overlay windows from the current dashboard. Used when
 * exiting VR-only mode.
 */
public restoreDesktopOverlays(): void {
  if (this.currentDashboard) {
    this.createOverlays(this.currentDashboard);
    logger.info('[OverlayManager] Desktop overlays restored.');
  }
}
```

`currentDashboard` is already stored (`:47`) and updated by
`onDashboardUpdated`, so `restoreDesktopOverlays` has what it needs. If the
dashboard changed while VR was active, the restored windows reflect the latest
layout.

#### 2. Call suppress on VR start, restore on VR stop

In `src/app/vr/vrOverlay.ts`, modify `startVrOverlay` and `stopVrOverlay`:

```typescript
export function startVrOverlay(
  overlayManager: OverlayManager,
  settings?: VrOverlaySettings
): void {
  if (osrWindow) return;
  // ... existing setup ...

  overlayManager.suppressDesktopOverlays();  // ← add before addExternalWindow

  overlayManager.addExternalWindow(osrWindow);
  // ... rest unchanged ...
}

export function stopVrOverlay(): void {
  try { VrOverlayNative.stop(); } catch (err) { logger.error('[VR] native stop failed', err); }
  if (osrWindow) {
    osrWindow.destroy();
    osrWindow = null;
  }
  // Restore desktop overlays so the user gets their monitor dashboard back.
  // The overlayManager reference is captured at start; see step 3.
}
```

#### 3. Keep a reference to `overlayManager` for restore

`startVrOverlay` receives `overlayManager` but `stopVrOverlay` doesn't. Store
it in a module-level variable:

```typescript
let overlayManagerRef: OverlayManager | null = null;

export function startVrOverlay(overlayManager: OverlayManager, settings?: VrOverlaySettings): void {
  overlayManagerRef = overlayManager;
  // ... existing ...
}

export function stopVrOverlay(): void {
  // ... existing destroy ...
  overlayManagerRef?.restoreDesktopOverlays();
  overlayManagerRef = null;
}
```

#### 4. Handle the settings window

The settings window (`currentSettingsWindow`) is **not** a display overlay —
it's separate. `closeAllOverlays` only closes `displayWindows`. So the user can
still open settings while in VR (on their monitor, before putting the headset
on, or via the taskbar). No change needed here.

#### 5. Handle dashboard updates while suppressed

`onDashboardUpdated` in `main.ts:91-93` calls `applyVrOverlaySettings`. The
dashboard update also triggers `overlayManager` to recreate/resize display
windows via its own listener. Since `closeAllOverlays` cleared
`displayWindows`, `ensureDisplayWindows` (`:681`) may try to recreate them.

Check how `onDashboardUpdated` flows to `overlayManager`. If it calls
`createOverlays` or `ensureDisplayWindows`, guard those so they're no-ops while
suppressed. Add a flag:

```typescript
// in OverlayManager
private desktopSuppressed = false;

public suppressDesktopOverlays(): void {
  this.desktopSuppressed = true;
  this.closeAllOverlays();
}

public restoreDesktopOverlays(): void {
  this.desktopSuppressed = false;
  if (this.currentDashboard) this.createOverlays(this.currentDashboard);
}
```

Then in `createOverlays` and `ensureDisplayWindows`, early-return if
`this.desktopSuppressed`:

```typescript
public createOverlays(dashboardLayout: DashboardLayout): void {
  if (this.desktopSuppressed) {
    this.currentDashboard = dashboardLayout;  // remember it for restore
    return;
  }
  // ... existing ...
}
```

This ensures that changing a widget setting while in VR doesn't silently
recreate the desktop windows.

### Code touch points

| File | Change |
| --- | --- |
| `src/app/overlayManager.ts` | `suppressDesktopOverlays` / `restoreDesktopOverlays`, `desktopSuppressed` flag, guards in `createOverlays` / `ensureDisplayWindows`. |
| `src/app/vr/vrOverlay.ts` | Store `overlayManagerRef`, call suppress on start, restore on stop. |

### How to test

1. **FPS comparison** — launch iRacing with a heavy session (full grid, high
   settings). Measure frame time with and without VR mode. Then measure with
   VR mode **before** this change (double render) and **after** (single render).
   Expect a measurable FPS improvement (the exact number depends on hardware,
   but the double Chromium compositing is the most expensive thing the app
   does).
2. **Desktop restored on stop** — start VR, confirm desktop overlays disappear
   (no irDashies windows on monitor). Stop VR (or quit the app), confirm the
   desktop overlays reappear with the current dashboard layout.
3. **Settings still works in VR** — while VR is active, open the settings
   window from the taskbar. Confirm it opens and functions (change a widget
   setting, confirm it takes effect in the VR overlay).
4. **Dashboard update while suppressed** — while VR is active, change the
   dashboard (add/remove a widget via settings). Confirm no desktop overlay
   window appears, and the VR overlay reflects the change on the next frame.
5. **Quit while VR-active** — quit the app while VR is running. Confirm clean
   shutdown (no orphaned windows, no crash). `before-quit` calls
   `stopVrOverlay` which calls `restoreDesktopOverlays`, but since the app is
   quitting, the restored windows are immediately closed — verify no error.

---

## P2 — Dedicated VR atlas page

### Goal

The OSR window loads the full renderer (`vrOverlay.ts:174-179`), which renders
**all** enabled widgets, subscribes to **all** telemetry, and loads settings
routes, edit-mode chrome, etc. Replace this with a **dedicated lightweight
page** that:

- Renders only VR-enabled widgets, packed into a known atlas layout.
- Reports each widget's atlas `sourceRect` to the main process via IPC.
- The main process calls `VrOverlayNative.setLayers([...])` with per-widget
  `sourceRect`, pose, size, opacity, visible — activating the multi-quad
  infrastructure that's already built (#04) but currently unused (the producer
  publishes a single full-atlas layer).

This reduces both the React workload (fewer components) and the Chromium
compositing workload (smaller dirty rects), and unlocks per-widget VR
placement.

### Why a route, not a separate entry point

The app already uses `HashRouter` (`App.tsx:3`) and distinguishes the settings
window by `window.location.hash.startsWith('#/settings')` (`:22`). A VR atlas
route follows the same pattern: `#/vr-atlas`. No new HTML entry point, no new
Vite config — just a route guarded by a hash check, like settings. The OSR
window loads `MAIN_WINDOW_VITE_DEV_SERVER_URL + '#/vr-atlas'` (dev) or
`index.html#/vr-atlas` (packaged).

### Step by step

#### 1. Add a `vrEnabled` flag to widget config

To know which widgets to show in VR, extend `DashboardWidget`
(`src/types/dashboardLayout.ts:15`) with an optional flag:

```typescript
export interface DashboardWidget {
  // ... existing fields ...
  /** Show this widget in the VR overlay. */
  vrEnabled?: boolean;
}
```

Default it to `false` in the type system (optional = absent = false). The
settings UI gets a per-widget "Show in VR" toggle later (future work); for now
the flag can default to `true` for all enabled widgets to match current
behaviour, or be set manually in the dashboard JSON.

#### 2. Create the VR atlas route in `App.tsx`

Add a hash check and a lightweight component tree:

```tsx
const isVrAtlasWindow = () => {
  return window.location.hash.startsWith('#/vr-atlas');
};

const VrAtlasApp = () => {
  return (
    <DashboardProvider bridge={window.dashboardBridge}>
      <RunningStateProvider bridge={window.irsdkBridge}>
        <SessionProvider bridge={window.irsdkBridge} />
        <TelemetryProvider bridge={window.irsdkBridge} />
        <VrAtlasContainer />
      </RunningStateProvider>
    </DashboardProvider>
  );
};

// in App component:
if (isVrAtlasWindow()) {
  return (
    <ErrorBoundary label="vr-atlas" resetAfterMs={2000}>
      <VrAtlasApp />
    </ErrorBoundary>
  );
}
```

Note what's **not** here vs the full `OverlayApp`:
- No `PitLaneProvider` / `ReferenceStoreProvider` (unless a VR widget needs
  them — add only when a widget requires it).
- No `HideUIWrapper` / `ProfileSwitchOverlay` / `ThemeManager` (VR has its own
  opacity/visual handling; the theme manager's CSS is desktop-oriented).
- No `SectorTimingUpdater` / `PushToPassUpdater` / `PitLapUpdater` (these are
  updaters for stores that desktop widgets use; add only if a VR widget needs
  the store).

This is the "subscribe only to what you need" win: fewer providers = fewer
store subscriptions = less React work per telemetry tick.

#### 3. Create `VrAtlasContainer`

A new component that renders VR-enabled widgets at fixed atlas coordinates:

```tsx
// src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx
import { memo, useEffect, useMemo, useCallback } from 'react';
import { useDashboard, useRunningState } from '@irdashies/context';
import { getWidget } from '../../WidgetIndex';
import { WidgetContainer } from '../WidgetContainer';
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary';
import type { WidgetLayout } from '@irdashies/types';

interface AtlasSlot {
  widgetId: string;
  layout: WidgetLayout;  // position in the atlas texture (texels)
}

export const VrAtlasContainer = memo(() => {
  const { currentDashboard } = useDashboard();
  const { running } = useRunningState();

  // Filter to VR-enabled widgets only.
  const vrWidgets = useMemo(
    () => currentDashboard?.widgets.filter((w) => w.enabled && w.vrEnabled) ?? [],
    [currentDashboard?.widgets]
  );

  // Pack widgets into the atlas. Simple shelf packing: lay out left-to-right,
  // wrap to next row when the row is full. The atlas width is the OSR window
  // width (texW from vrOverlay.ts); height grows as needed.
  const atlasWidth = window.innerWidth;  // matches the OSR backing texture
  const padding = 4;  // texels between widgets

  const slots = useMemo<AtlasSlot[]>(() => {
    const result: AtlasSlot[] = [];
    let x = 0, y = 0, rowH = 0;
    for (const w of vrWidgets) {
      const ww = w.layout.width;
      const wh = w.layout.height;
      if (x + ww > atlasWidth && x > 0) { x = 0; y += rowH + padding; rowH = 0; }
      result.push({ widgetId: w.id, layout: { x, y, width: ww, height: wh } });
      x += ww + padding;
      rowH = Math.max(rowH, wh);
    }
    return result;
  }, [vrWidgets, atlasWidth]);

  // Report the atlas layout to the main process so it can call setLayers().
  useEffect(() => {
    if (!window.vrAtlasBridge) return;
    const layers = slots.map((s) => {
      const w = vrWidgets.find((w) => w.id === s.widgetId)!;
      return {
        widgetId: s.widgetId,
        sourceRect: [s.layout.x, s.layout.y, s.layout.width, s.layout.height],
      };
    });
    window.vrAtlasBridge.reportLayout(layers);
  }, [slots, vrWidgets]);

  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none">
      {slots.map((slot, index) => {
        const widget = vrWidgets.find((w) => w.id === slot.widgetId);
        if (!widget) return null;
        const WidgetComponent = getWidget(widget.type || widget.id);
        if (!WidgetComponent) return null;
        return (
          <WidgetContainer
            key={widget.id}
            widget={{ ...widget, layout: slot.layout }}
            editMode={false}
            zIndex={index + 1}
          >
            {(running || widget.alwaysEnabled) ? (
              <ErrorBoundary label={`vr-widget:${widget.type || widget.id}`} resetAfterMs={2000}>
                <WidgetComponent {...widget.config} />
              </ErrorBoundary>
            ) : null}
          </WidgetContainer>
        );
      })}
    </div>
  );
});
VrAtlasContainer.displayName = 'VrAtlasContainer';
```

Key differences from `OverlayContainer`:
- No edit-mode UI (no drag handles, no exit button, no `handleLayoutChange`).
- No per-display filtering (the atlas is one surface).
- No `hiddenWidgetIds` hotkey logic (not needed in VR).
- Widgets are positioned at **atlas coordinates** (packed), not at their
  desktop layout positions. The desktop layout's `x/y` is only used for
  `width`/`height`; the atlas packer assigns new `x/y`.
- The `sourceRect` is reported to the main process via a dedicated bridge.

#### 4. Add the `vrAtlasBridge` IPC

The renderer needs a way to report the atlas layout (widgetId → sourceRect) to
the main process. Follow the existing bridge pattern.

**Preload** (add to `preload.ts`):
```typescript
const vrAtlasBridge = {
  reportLayout: (layers: { widgetId: string; sourceRect: [number, number, number, number] }[]) =>
    ipcRenderer.send('vr-atlas-layout', layers),
};
contextBridge.exposeInMainWorld('vrAtlasBridge', vrAtlasBridge);
```

**Main process** (in `vrOverlay.ts` or a dedicated handler):
```typescript
import { ipcMain } from 'electron';

let atlasLayout: { widgetId: string; sourceRect: [number, number, number, number] }[] = [];

ipcMain.on('vr-atlas-layout', (_event, layers) => {
  atlasLayout = layers;
  publishVrLayers();
});

function publishVrLayers() {
  if (!osrWindow) return;
  const settings = currentVrSettings;  // captured from startVrOverlay
  const layers = atlasLayout.map((l) => ({
    position: [settings.horizontal, settings.vertical, -settings.distance],
    orientation: [0, 0, 0, 1],
    size: [settings.width, settings.width * quadAspect],
    sourceRect: l.sourceRect,
    opacity: 1,
    visible: 1,
  }));
  VrOverlayNative.setLayers(layers);
}
```

For the MVP, all VR widgets share the same pose (the global VR settings). When
per-widget pose settings land (future work), each layer gets its own pose from
a per-widget VR config.

#### 5. Load the VR atlas route in the OSR window

In `vrOverlay.ts:174-179`:

```typescript
if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
  wc.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#/vr-atlas`);
} else {
  osrWindow.loadFile(
    path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    { hash: 'vr-atlas' }
  );
}
```

`loadFile` with `{ hash: 'vr-atlas' }` sets `window.location.hash` to
`#vr-atlas`, which `isVrAtlasWindow()` checks with `startsWith('#/vr-atlas')`.
Note: `loadFile`'s `hash` option does not add the leading `/`, so either use
`#vr-atlas` in `loadFile` and check `startsWith('#vr-atlas')`, or use
`#/vr-atlas` and adjust. Verify the exact hash format with a `console.log` on
first load.

#### 6. Atlas size

The OSR window is created at `texW × texH` (supersampled, up to 2048).
`window.innerWidth` in the renderer matches `texW` because the OSR backing
texture is the window size. The atlas packer uses this width as the row limit
and grows vertically. If the packed height exceeds `texH`, either:
- Increase `texH` (recreate the OSR window — complex), or
- Scale down widgets that don't fit (simple: clamp the atlas to one row and
  shrink widget heights to fit), or
- For the MVP, just ensure the number/size of VR widgets fits within the
  `texW × texH` budget. With a 2048×1152 atlas and typical widgets
  (300×200 px each), that's ~6-8 widgets per row, ~5 rows — more than enough.

### Code touch points

| File | Change |
| --- | --- |
| `src/types/dashboardLayout.ts` | `vrEnabled?: boolean` on `DashboardWidget`. |
| `src/frontend/App.tsx` | `isVrAtlasWindow()` check, `VrAtlasApp` tree (lighter providers). |
| `src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx` | New component (atlas packer + widget rendering + layout reporting). |
| `src/preload.ts` (or equivalent) | `vrAtlasBridge` IPC expose. |
| `src/app/vr/vrOverlay.ts` | Load `#/vr-atlas` route; `ipcMain.on('vr-atlas-layout')` handler; `publishVrLayers()` calling `setLayers`. |

### How to test

1. **Route loads correctly** — start the app with `IRDASHIES_VR=1`. Confirm
   the OSR window loads the `#/vr-atlas` route (check DevTools: open the OSR
   window's DevTools via `osrWindow.webContents.openDevTools()` temporarily,
   confirm `window.location.hash` is `#vr-atlas` and only `VrAtlasContainer`
   renders, not `OverlayContainer`).
2. **Only VR-enabled widgets render** — set `vrEnabled: true` on 2 widgets and
   `vrEnabled: false` on others in the dashboard JSON. Confirm only the 2
   VR-enabled widgets appear in the OSR DevTools Elements panel.
3. **Layout reported to main process** — add a `logger.info` in the
   `vr-atlas-layout` IPC handler. Confirm it logs the correct `sourceRect`
   values matching the atlas packer's output.
4. **Multi-quad in headset** — with the OpenXR layer running, confirm each
   VR-enabled widget appears as a **separate quad** in the headset at the
   shared pose. Verify `sourceRect` sub-sampling: each quad shows only its
   widget's content, not the whole atlas.
5. **Telemetry subscription reduction** — with the React DevTools Profiler,
   compare the number of store subscriptions and re-renders per telemetry tick
   between the full `OverlayApp` and `VrAtlasApp`. Expect fewer subscriptions
   (no PitLane/ReferenceStore, no edit-mode observers, fewer widgets).
6. **FPS comparison** — repeat P1's FPS test with P2 applied. Expect further
   improvement from the lighter renderer (fewer React reconciliations + smaller
   compositing dirty rects).
7. **Widget toggle** — toggle `vrEnabled` on a widget via settings while VR is
   active. Confirm the quad appears/disappears within 1-2 frames (the layout
   effect re-reports, `setLayers` is called, the consumer picks it up next
   `xrEndFrame`).

---

## Summary: expected performance impact

| Change | What it eliminates | Expected impact |
| --- | --- | --- |
| P1 (VR-only mode) | 2nd Chromium compositor, 2nd full React tree, 2nd set of telemetry subscriptions | **High** — the single biggest win. Eliminates ~50% of the app's per-frame CPU/GPU overhead. |
| P2 (atlas page) | Unused widgets, unused providers (PitLane, ReferenceStore), edit-mode chrome, settings routes | **Medium** — proportional to how many widgets are desktop-only. With 20 widgets and 4 in VR, ~80% less React work in the OSR window. |

P1 alone should recover most of the FPS cost of running irDashies in VR. P2
compounds it and unlocks per-widget VR placement (the `setLayers` multi-quad
path that's currently dormant).

## References

- The double-render problem is flagged in `vr-openxr-design.md:112`:
  "Desktop overlay run simultaneous with VR, or VR-mode swap window to
  OSR-only? (double render cost vs mode switch)".
- The atlas page is listed in `08-implementation-summary.md` "Future work":
  "VR atlas page — render all VR-enabled widgets into a single React page".
- The multi-quad consumer infrastructure is already built
  (`layer.cpp:688-733`, `vr_overlay.cc:411-439`); it's just waiting for
  `setLayers` to be called with per-widget `sourceRect` values instead of the
  current single full-atlas layer (`vrOverlay.ts:87-96`).
