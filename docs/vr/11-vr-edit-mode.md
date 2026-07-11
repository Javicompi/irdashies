# 11 — In-headset VR edit mode (per-widget positioning)

## Goal

Let the user position each VR overlay **independently** from inside the headset,
using keyboard shortcuts — no settings panel, no mouse, no OpenXR controllers.

When the user presses **F9**, the app enters "VR edit mode":

1. Each VR-enabled widget becomes an **independent quad** with its own 3D pose
   (X, Y, Z position in metres, LOCAL space).
2. An **instructions overlay** appears at a fixed position (bottom-centre)
   showing the keyboard controls and the selected widget's current X/Y/Z
   values, which update live as the user moves it.
3. The **currently selected widget** gets a **green border** (stroke) drawn
   inside its atlas sub-rect, so the user sees which widget they're editing.
4. The user cycles between widgets with **Space**, moves the selected one with
   **arrow keys** (X/Y), and adjusts distance with **Q/E** (Z).
5. Pressing **F9** again exits edit mode: the green borders and instructions
   overlay disappear, the final positions are saved to the dashboard.

At all times the overlays continue rendering through the existing
atlas → SHM → OpenXR layer pipeline. Edit mode only changes **what quads are
published** (N per-widget quads instead of 1 full-atlas quad) and **what the
atlas page renders** (green borders + instructions panel).

## Design constraints

- **Keyboard only.** iRacing has the focus; Electron's `globalShortcut` captures
  keys at the OS level before they reach the game. All edit-mode keys are
  registered on enter and unregistered on exit, so iRacing is unaffected outside
  edit mode.
- **No new native code.** Everything is Electron + React + the existing SHM
  `setLayers` infrastructure. No mouse hooks, no OpenXR action sets.
- **No SHM contract change.** The `IrdashiesShmLayer[]` table and `setLayers`
  already exist (#04). Edit mode just feeds it per-widget data instead of one
  full-atlas layer.
- **Per-widget pose is optional.** Widgets without a saved `vrPosition`
  default to the centre `[0, 0, -distance]` (from global VR settings). This
  means the first time a user enters edit mode, all widgets are stacked at the
  centre — they spread them out from there.

---

## Architecture overview

```
[Electron main process]
  globalShortcut (F9, Space, arrows, Q/E)
    │
    ├─ F9 → toggle vrEditMode
    │       ├─ enter: register edit keys, broadcast 'vr-edit-mode' (true) to OSR window
    │       └─ exit:  unregister edit keys, broadcast 'vr-edit-mode' (false), save dashboard
    │
    ├─ Space → cycle selectedWidgetId, broadcast 'vr-edit-select' (widgetId)
    │
    ├─ arrows/Q/E → update selected widget's vrPosition, broadcast 'vr-edit-move', republish layers
    │
    └─ publishVrLayers() — NOW publishes N per-widget layers (one per VR widget)
         └─ VrOverlayNative.setLayers([
              { position: [x,y,z], sourceRect: widget.subRect, visible: 1, ... },
              ...
            ])

[VR atlas page (React, OSR window)]
  ipc 'vr-edit-mode' (bool)   → setEditMode(true/false)
  ipc 'vr-edit-select' (id)   → setSelectedWidgetId(id)
  ipc 'vr-edit-move' (pos)    → setLivePosition(pos)  // for instructions display

  VrAtlasContainer renders:
    ├─ widgets (same as now)
    ├─ if editMode: green border (border-2 border-green-500) on selectedWidgetId
    └─ if editMode: <VrEditInstructions> panel (bottom centre, fixed pose)
```

---

## Step-by-step implementation

### 1. Per-widget VR position in the dashboard type

**File:** `src/types/dashboardLayout.ts:15` (`DashboardWidget`)

Add an optional `vrPosition` field:

```typescript
export interface DashboardWidget {
  // ... existing fields ...
  /** Show this widget in the VR overlay (defaults to true for all widgets). */
  vrEnabled?: boolean;
  /**
   * Per-widget 3D position in the VR overlay (metres, LOCAL space).
   * [x, y, z] where z is negative (in front of user). When absent, the widget
   * uses the global VR settings position (centred by default).
   */
  vrPosition?: [number, number, number];
  // ... existing fields ...
}
```

No migration needed — absent `vrPosition` means "use the shared default
position from `VrOverlaySettings`". The settings migration system
(`migrateConfig`) only needs a fallback if you want to be explicit, but the
`??` operator in the consumer handles it.

### 2. VR edit-mode state in the main process

**File:** `src/app/vr/vrOverlay.ts`

Add edit-mode state and a function to publish per-widget layers:

```typescript
// Edit-mode state (session-only, not persisted until exit).
let vrEditMode = false;
let selectedWidgetIndex = 0;
let selectedWidgetId: string | null = null;

// Live position of the selected widget (for the instructions overlay display).
let liveEditPosition: [number, number, number] = [0, 0, -1.5];
```

Replace the current `publishVrLayers` (which publishes a single full-atlas
layer) with a version that publishes one layer per VR widget:

```typescript
function publishVrLayers(): void {
  if (!osrWindow) return;
  const pose = currentVrPose ?? DEFAULT_POSE;

  if (!vrEditMode) {
    // Normal mode: single full-atlas quad (current behaviour).
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
    return;
  }

  // Edit mode: one quad per VR widget, each with its own pose.
  const globalPose = pose;  // fallback for widgets without vrPosition
  const layers = atlasLayout.map((slot) => ({
    position: getWidgetVrPosition(slot.widgetId, globalPose),
    orientation: globalPose.orientation ?? DEFAULT_POSE.orientation,
    size: globalPose.size ?? DEFAULT_POSE.size,
    sourceRect: slot.sourceRect,
    opacity: 1,
    visible: 1,
  }));
  VrOverlayNative.setLayers(layers);
}

function getWidgetVrPosition(
  widgetId: string,
  globalPose: VrPose
): [number, number, number] {
  // Look up the widget's saved vrPosition from the current dashboard.
  // Falls back to the global pose position if not set.
  const widget = currentDashboard?.widgets.find((w) => w.id === widgetId);
  return widget?.vrPosition ?? (globalPose.position ?? DEFAULT_POSE.position);
}
```

You need access to `currentDashboard` in `vrOverlay.ts`. Add a module-level
reference that's updated when the dashboard changes:

```typescript
let currentDashboard: DashboardLayout | undefined;

// In main.ts, where applyVrOverlaySettings is called, also pass the dashboard:
export function updateVrDashboard(dashboard: DashboardLayout): void {
  currentDashboard = dashboard;
}
```

Wire `updateVrDashboard` in `main.ts:91-93` alongside the existing
`applyVrOverlaySettings` call.

### 3. Edit-mode keyboard handling

**File:** `src/app/vr/vrOverlay.ts`

Add these functions:

```typescript
const EDIT_KEYS: Record<string, () => void> = {};
let editKeysRegistered = false;

function registerEditKeys(): void {
  if (editKeysRegistered) return;
  editKeysRegistered = true;

  const register = (accel: string, handler: () => void) => {
    if (!globalShortcut.isRegistered(accel)) {
      globalShortcut.register(accel, handler);
    }
  };

  register('Space', () => cycleSelectedWidget());
  register('Left',  () => moveSelected(-0.01, 0, 0));
  register('Right', () => moveSelected( 0.01, 0, 0));
  register('Up',    () => moveSelected(0,  0.01, 0));
  register('Down',  () => moveSelected(0, -0.01, 0));
  register('Q',     () => moveSelected(0, 0, -0.01));  // closer
  register('E',     () => moveSelected(0, 0,  0.01));  // farther
}

function unregisterEditKeys(): void {
  if (!editKeysRegistered) return;
  editKeysRegistered = false;
  for (const accel of ['Space', 'Left', 'Right', 'Up', 'Down', 'Q', 'E']) {
    if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
  }
}
```

**Movement step**: `0.01` metres per key press (1 cm).考虑到 holding a key
generates repeat events at the OS level, the user can hold for continuous
movement. If the repeat rate is too slow/fast, expose the step as a constant
that's easy to tune.

### 4. Toggle edit mode (F9)

**File:** `src/app/vr/vrOverlay.ts`

F9 is already a `globalShortcut` registered by `KeybindingManager`? No — it's
not in the keybindings map. F9 should be registered **only while VR is active**,
not globally. Register it in `startVrOverlay`, unregister in `stopVrOverlay`:

```typescript
// In startVrOverlay, after the OSR window is created:
globalShortcut.register('F9', toggleVrEditMode);

// In stopVrOverlay, before destroying:
unregisterEditKeys();
if (globalShortcut.isRegistered('F9')) globalShortcut.unregister('F9');
vrEditMode = false;
```

The toggle function:

```typescript
function toggleVrEditMode(): void {
  if (!osrWindow || osrWindow.isDestroyed()) return;
  vrEditMode = !vrEditMode;

  if (vrEditMode) {
    // Enter edit mode: select the first VR widget, register edit keys.
    selectedWidgetIndex = 0;
    selectedWidgetId = atlasLayout[0]?.widgetId ?? null;
    if (selectedWidgetId) {
      liveEditPosition = getWidgetVrPosition(selectedWidgetId, currentVrPose ?? DEFAULT_POSE);
    }
    registerEditKeys();
    logger.info('[VR] edit mode ON');
  } else {
    // Exit edit mode: unregister edit keys, save positions to dashboard.
    unregisterEditKeys();
    saveVrPositionsToDashboard();
    selectedWidgetId = null;
    logger.info('[VR] edit mode OFF — positions saved');
  }

  // Notify the OSR window (React) so it can show/hide borders + instructions.
  osrWindow.webContents.send('vr-edit-mode', vrEditMode, selectedWidgetId, liveEditPosition);
  publishVrLayers();
}
```

### 5. Cycle selected widget (Space)

```typescript
function cycleSelectedWidget(): void {
  if (!vrEditMode || atlasLayout.length === 0) return;
  selectedWidgetIndex = (selectedWidgetIndex + 1) % atlasLayout.length;
  selectedWidgetId = atlasLayout[selectedWidgetIndex].widgetId;
  liveEditPosition = getWidgetVrPosition(selectedWidgetId, currentVrPose ?? DEFAULT_POSE);
  if (osrWindow && !osrWindow.isDestroyed()) {
    osrWindow.webContents.send('vr-edit-select', selectedWidgetId, liveEditPosition);
  }
}
```

### 6. Move selected widget (arrows / Q / E)

```typescript
function moveSelected(dx: number, dy: number, dz: number): void {
  if (!vrEditMode || !selectedWidgetId || !currentDashboard) return;

  liveEditPosition = [
    +(liveEditPosition[0] + dx).toFixed(3),
    +(liveEditPosition[1] + dy).toFixed(3),
    +(liveEditPosition[2] + dz).toFixed(3),
  ];

  // Notify the OSR window (React) so the instructions overlay shows live values.
  if (osrWindow && !osrWindow.isDestroyed()) {
    osrWindow.webContents.send('vr-edit-move', liveEditPosition);
  }

  publishVrLayers();
}
```

Note: `moveSelected` does **not** write to the dashboard on every key press —
it only updates the live `liveEditPosition` and republishes layers (the
consumer reads from `getWidgetVrPosition` which reads from the live state).
The dashboard is saved **once** on exit (see step 7). This avoids disk writes
on every arrow press.

But `getWidgetVrPosition` currently reads from `currentDashboard`. During
edit mode it must read from `liveEditPosition` for the selected widget:

```typescript
function getWidgetVrPosition(
  widgetId: string,
  globalPose: VrPose
): [number, number, number] {
  if (vrEditMode && widgetId === selectedWidgetId) {
    return liveEditPosition;
  }
  const widget = currentDashboard?.widgets.find((w) => w.id === widgetId);
  return widget?.vrPosition ?? (globalPose.position ?? DEFAULT_POSE.position);
}
```

### 7. Save positions on exit

```typescript
function saveVrPositionsToDashboard(): void {
  if (!currentDashboard) return;
  // Write the live position of the last-selected widget back to the dashboard.
  // All other widgets already have their vrPosition from previous edits.
  if (selectedWidgetId) {
    const widgets = currentDashboard.widgets.map((w) =>
      w.id === selectedWidgetId
        ? { ...w, vrPosition: liveEditPosition }
        : w
    );
    const updated = { ...currentDashboard, widgets };
    currentDashboard = updated;
    // Trigger the existing save pipeline.
    saveDashboard(getCurrentProfileId(), updated);
  }
}
```

Use the existing `saveDashboard` from `src/app/storage/dashboards.ts:122`. This
writes to disk and emits the `onDashboardUpdated` event so other parts of the
app (desktop overlays, settings) pick up the change.

**Important:** during edit mode, `moveSelected` only updates `liveEditPosition`
in memory. The dashboard's `vrPosition` for the selected widget is only
persisted when the user exits edit mode. If the user cycles to another widget,
the previous widget's `liveEditPosition` must be committed to `currentDashboard`
so it's not lost:

```typescript
function cycleSelectedWidget(): void {
  if (!vrEditMode || atlasLayout.length === 0) return;

  // Commit the current widget's live position before switching.
  commitLivePositionToDashboard();

  selectedWidgetIndex = (selectedWidgetIndex + 1) % atlasLayout.length;
  selectedWidgetId = atlasLayout[selectedWidgetIndex].widgetId;
  liveEditPosition = getWidgetVrPosition(selectedWidgetId, currentVrPose ?? DEFAULT_POSE);
  // ... rest unchanged ...
}

function commitLivePositionToDashboard(): void {
  if (!currentDashboard || !selectedWidgetId) return;
  const widgets = currentDashboard.widgets.map((w) =>
    w.id === selectedWidgetId
      ? { ...w, vrPosition: liveEditPosition }
      : w
  );
  currentDashboard = { ...currentDashboard, widgets };
}
```

And call `commitLivePositionToDashboard()` at the start of
`saveVrPositionsToDashboard()` too (for the last-edited widget).

### 8. IPC bridge for edit-mode events

**File:** `src/app/rendererExpose.ts`

Add IPC channels the main process sends to the OSR window:

```typescript
// Inside exposeInMainWorld, after vrAtlasBridge:
contextBridge.exposeInMainWorld('vrEditBridge', {
  onEditMode: (cb: (active: boolean, selectedId: string | null, position: [number, number, number]) => void) => {
    const listener = (_: Electron.IpcRendererEvent, active: boolean, selectedId: string | null, position: [number, number, number]) =>
      cb(active, selectedId, position);
    ipcRenderer.on('vr-edit-mode', listener);
    return () => ipcRenderer.removeListener('vr-edit-mode', listener);
  },
  onSelect: (cb: (widgetId: string, position: [number, number, number]) => void) => {
    const listener = (_: Electron.IpcRendererEvent, widgetId: string, position: [number, number, number]) =>
      cb(widgetId, position);
    ipcRenderer.on('vr-edit-select', listener);
    return () => ipcRenderer.removeListener('vr-edit-select', listener);
  },
  onMove: (cb: (position: [number, number, number]) => void) => {
    const listener = (_: Electron.IpcRendererEvent, position: [number, number, number]) =>
      cb(position);
    ipcRenderer.on('vr-edit-move', listener);
    return () => ipcRenderer.removeListener('vr-edit-move', listener);
  },
});
```

**File:** `src/interface.d.ts`

```typescript
declare global {
  interface Window {
    // ... existing ...
    vrEditBridge?: {
      onEditMode: (cb: (active: boolean, selectedId: string | null, position: [number, number, number]) => void) => () => void;
      onSelect: (cb: (widgetId: string, position: [number, number, number]) => void) => () => void;
      onMove: (cb: (position: [number, number, number]) => void) => () => void;
    };
  }
}
```

### 9. VrAtlasContainer: green border + edit state

**File:** `src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx`

Add edit-mode state and a green border on the selected widget:

```tsx
import { memo, useEffect, useMemo, useState } from 'react';

export const VrAtlasContainer = memo(() => {
  const { currentDashboard } = useDashboard();
  const { running } = useRunningState();

  // VR edit-mode state (driven by IPC from the main process).
  const [editMode, setEditMode] = useState(false);
  const [selectedWidgetId, setSelectedWidgetId] = useState<string | null>(null);
  const [, setLivePosition] = useState<[number, number, number]>([0, 0, -1.5]);

  useEffect(() => {
    if (!window.vrEditBridge) return;
    const unmode = window.vrEditBridge.onEditMode((active, id, pos) => {
      setEditMode(active);
      setSelectedWidgetId(id);
      setLivePosition(pos);
    });
    const unsel = window.vrEditBridge.onSelect((id, pos) => {
      setSelectedWidgetId(id);
      setLivePosition(pos);
    });
    const unmove = window.vrEditBridge.onMove((pos) => setLivePosition(pos));
    return () => { unmode(); unsel(); unmove(); };
  }, []);

  // ... existing vrWidgets + slots useMemo ...

  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none">
      {slots.map((slot, index) => {
        const widget = vrWidgets.find((w) => w.id === slot.widgetId);
        if (!widget) return null;
        const WidgetComponent = getWidget(widget.type || widget.id);
        if (!WidgetComponent) return null;
        const isSelected = editMode && selectedWidgetId === widget.id;
        return (
          <WidgetContainer
            key={widget.id}
            widget={{
              ...widget,
              layout: { x: slot.x, y: slot.y, width: slot.width, height: slot.height },
            }}
            editMode={false}
            zIndex={index + 1}
            onLayoutChange={noop}
          >
            {running || widget.alwaysEnabled ? (
              <ErrorBoundary label={`vr-widget:${widget.type || widget.id}`} resetAfterMs={2000}>
                <div className={isSelected ? 'outline outline-2 outline-green-500' : ''}>
                  <WidgetComponent {...widget.config} />
                </div>
              </ErrorBoundary>
            ) : null}
          </WidgetContainer>
        );
      })}
      {editMode && <VrEditInstructions />}
    </div>
  );
});
```

The `outline` class (Tailwind) draws a 2px green border **inside** the widget's
bounds — no layout shift, no size change. The border is visible in the atlas
texture, so the OpenXR quad shows it. Use `outline` instead of `border` so it
doesn't affect the widget's box model.

### 10. The instructions overlay component

**File:** `src/frontend/components/VrAtlasContainer/VrEditInstructions.tsx`

A lightweight, self-contained panel that lives at a fixed position in the
atlas and shows the controls + live position values:

```tsx
import { memo, useState, useEffect } from 'react';

export const VrEditInstructions = memo(() => {
  const [position, setPosition] = useState<[number, number, number]>([0, 0, -1.5]);

  useEffect(() => {
    if (!window.vrEditBridge) return;
    const unmove = window.vrEditBridge.onMove((pos) => setPosition(pos));
    const unsel = window.vrEditBridge.onSelect((_, pos) => setPosition(pos));
    const unmode = window.vrEditBridge.onEditMode((_, __, pos) => setPosition(pos));
    return () => { unmove(); unsel(); unmode(); };
  }, []);

  const fmt = (n: number) => n.toFixed(2);

  return (
    <div
      className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[9999]
                 bg-slate-900/95 border border-slate-600/25 rounded
                 px-8 py-5 text-white font-sans pointer-events-none"
      style={{ minWidth: '440px' }}
    >
      <div className="flex flex-col gap-2 mb-3">
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">F9</span>
          <span className="text-white/75">Exit edit mode</span>
        </div>
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Space</span>
          <span className="text-white/75">Cycle overlay</span>
        </div>
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Arrow keys</span>
          <span className="text-white/75">Adjust position X / Y</span>
        </div>
        <div className="flex items-baseline text-sm">
          <span className="w-48 font-bold text-slate-300">Q / E</span>
          <span className="text-white/75">Adjust distance Z</span>
        </div>
      </div>
      <div className="flex items-baseline justify-between text-sm pt-3 border-t border-slate-600/20">
        <span className="font-bold text-slate-300">Position</span>
        <div className="flex gap-6">
          <span className="font-bold text-green-400 tabular-nums min-w-[64px] text-center">X: {fmt(position[0])}</span>
          <span className="font-bold text-green-400 tabular-nums min-w-[64px] text-center">Y: {fmt(position[1])}</span>
          <span className="font-bold text-green-400 tabular-nums min-w-[64px] text-center">Z: {fmt(position[2])}</span>
        </div>
      </div>
    </div>
  );
});
VrEditInstructions.displayName = 'VrEditInstructions';
```

Style notes:
- `font-sans` maps to Lato (the project's theme font).
- Colours match the existing overlay palette: `slate-900/95` background,
  `white/75` text, `slate-300` labels, `green-400` for live values.
- `tabular-nums` keeps the X/Y/Z digits from jittering as they change.
- `pointer-events-none` so it never intercepts input (it's display-only).
- No icons, no Phosphor, no emojis (per project rules).

The component is placed at `bottom-8 left-1/2` in the atlas. Since the atlas
maps 1:1 to the quad, this corresponds to the bottom-centre of the quad. In
edit mode the quad for the instructions is a separate layer in the layer table
with a fixed pose (bottom-centre, closer than the widgets). See step 11.

### 11. Instructions overlay as a separate quad

The instructions panel needs to be **always visible and fixed** while widgets
move around. If it were part of the widget atlas, moving a widget over it
would occlude it. Two options:

**A. Same atlas, fixed position (recommended for MVP).** The instructions panel
is at a fixed position in the atlas (bottom-centre). In edit mode,
`publishVrLayers` publishes the widget quads **plus** one extra quad for the
instructions area, using a `sourceRect` that covers only the bottom strip of
the atlas.

The atlas page renders the instructions at the bottom of the atlas. The
`sourceRect` for the instructions quad is something like
`[0, atlasH - 200, atlasW, 200]` (a bottom strip). This quad has a fixed pose
(close, centred, below the widgets) so it's always readable.

**B. Separate OSR window (rejected).** A second OSR surface just for the
instructions. More expensive (second Chromium compositor, second SHM slot) and
violates the "one consumer" principle.

For the MVP, option A is simpler. The instructions panel is rendered by React
at the bottom of the atlas page, and `publishVrLayers` in edit mode adds one
extra layer with a `sourceRect` for that bottom strip.

In `publishVrLayers`, edit-mode branch, after mapping widget layers:

```typescript
// Add the instructions overlay as a fixed quad at the bottom of the atlas.
const instrH = 200;  // matches the CSS height of the instructions panel
layers.push({
  position: [0, -0.15, -1.2],  // closer and slightly below centre
  orientation: [0, 0, 0, 1],
  size: [pose.size ?? DEFAULT_POSE.size],
  sourceRect: [0, atlasTexH - instrH, atlasTexW, instrH],
  opacity: 1,
  visible: 1,
});
```

Fine-tune the instructions quad pose (closer, below) during in-headset testing.

---

## Code touch points summary

| File | Change |
| --- | --- |
| `src/types/dashboardLayout.ts` | `vrPosition?: [number, number, number]` on `DashboardWidget`. |
| `src/app/vr/vrOverlay.ts` | Edit-mode state, `toggleVrEditMode`, `cycleSelectedWidget`, `moveSelected`, `registerEditKeys`/`unregisterEditKeys`, per-widget `publishVrLayers`, `saveVrPositionsToDashboard`, `commitLivePositionToDashboard`, F9 registration on start/stop, `updateVrDashboard`. |
| `src/app/rendererExpose.ts` | `vrEditBridge` IPC (`onEditMode`, `onSelect`, `onMove`). |
| `src/interface.d.ts` | `vrEditBridge` type declaration. |
| `src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx` | Edit-mode state (from IPC), green `outline` on selected widget, render `<VrEditInstructions>` when active. |
| `src/frontend/components/VrAtlasContainer/VrEditInstructions.tsx` | New: instructions panel with live X/Y/Z display. |
| `src/main.ts` | Wire `updateVrDashboard` in the `onDashboardUpdated` callback. |

---

## Keybindings and iRacing conflicts

| Key | iRacing default | Edit mode action | Conflict resolution |
| --- | --- | --- | --- |
| F9 | None | Enter/exit edit mode | None — registered only while VR is active. |
| Space | Chat | Cycle overlay | Intercepted by `globalShortcut` only during edit mode; iRacing never receives it. iRacing chat works normally outside edit mode. |
| Arrow keys | Look around (cockpit) | Move X/Y | Same — intercepted only during edit mode. |
| Q | Clutch | Adjust Z (closer) | Same. |
| E | Turn signal (if assigned) | Adjust Z (farther) | Same. |

All edit-mode keys are registered on enter and unregistered on exit. The user
is not driving while positioning overlays, so losing these keys temporarily is
acceptable.

---

## How to test

1. **Enter edit mode** — with VR active and overlays visible, press F9.
   Confirm: the instructions panel appears at the bottom, the first widget has
   a green border, and iRacing does not react to F9.

2. **Cycle widgets** — press Space. Confirm: the green border moves to the
   next widget. The instructions panel stays visible. The X/Y/Z values update
   to show the newly selected widget's position.

3. **Move a widget** — with arrow keys, move the selected widget. Confirm:
   - The widget moves in the headset (X = left/right, Y = up/down).
   - The X/Y values in the instructions panel update live (green text).
   - iRacing does not receive the arrow keys (the driver's view doesn't pan).

4. **Adjust distance** — press Q/E. Confirm:
   - The widget moves closer/farther in the headset.
   - Z updates live.

5. **Exit and save** — press F9 again. Confirm:
   - Green borders and instructions panel disappear.
   - Overlays stay at their new positions (the per-widget quads re-render).
   - The dashboard JSON on disk now has `vrPosition` for each moved widget
     (`grep vrPosition` in the storage file).
   - iRacing keys (Space chat, arrow keys, Q clutch) work normally again.

6. **Restart** — quit and restart the app + VR. Confirm: widgets appear at
   their saved positions (not the default centre).

7. **Multiple widgets** — with 4+ VR-enabled widgets, cycle through all of
   them, move each to a different spot, exit, restart. Confirm all positions
   persist independently.

8. **No VR widgets** — enter edit mode with 0 VR-enabled widgets. Confirm:
   nothing crashes; the instructions panel shows but no widget is selected.

9. **Quit while in edit mode** — quit the app while edit mode is active.
   Confirm: `stopVrOverlay` unregisters all edit keys and F9; no orphaned
   global shortcuts remain (verify by opening iRacing chat with Space after
   the app closes).

---

## References

- `KeybindingManager` (`src/app/keybindingManager.ts`): existing
  `globalShortcut.register`/`unregister` pattern, used for all app keybindings.
- `VrOverlayNative.setLayers` (`src/app/vr/native/index.d.ts:36`): already
  accepts a `LayerConfig[]` array — no native change needed.
- `IrdashiesShmLayer` (`native/shared/irdashies_shm.h:40-47`): already has
  `posePosition`, `sourceRect`, `opacity`, `visible` — no SHM change needed.
- The consumer's N-quad loop (`native/openxr-layer/src/layer.cpp:688-733`):
  already builds one `XrCompositionLayerQuad` per layer with its own
  `imageRect` and pose — no consumer change needed.
- Mockup HTML: see `vr-edit-mode-mockup.html` (rendered in this session).