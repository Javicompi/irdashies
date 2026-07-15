# VR Audit: Issues & Improvements

Results of the audit of the VR overlay flow from first install to in-headset display.
Ordered by priority (highest first).

---

## 1. No error feedback when OpenXR layer registration fails

**Severity: High | File: `src/app/vr/vrOverlay.ts:296-363`**

`registerVrLayer()` spawns an elevated PowerShell subprocess to copy the DLL to `%ProgramFiles%` and write `HKLM` registry keys. If the user doesn't have admin rights, cancels the UAC prompt, or the PowerShell command fails for any reason, the function only logs a warning (`logger.warn`). The VR toggle in the Settings UI still shows as enabled, but the OpenXR layer was never registered, so no overlay will ever appear in the headset.

**Fix:**
- Expose a registration status via IPC so the frontend can show an error banner in `VrSettings.tsx`.
- Or check registry + DLL existence after the elevated command and surface the result to the frontend.
- Consider a retry button in the UI.

---

## 2. Edit mode resets all saved widget positions on entry

**Severity: High | File: `src/app/vr/vrOverlay.ts:165-174`**

```typescript
if (currentDashboard) {
  currentDashboard = {
    ...currentDashboard,
    widgets: currentDashboard.widgets.map((w) => ({
      ...w,
      vrAtlasX: undefined,
      vrAtlasY: undefined,
    })),
  };
}
```

When entering edit mode (`Ctrl+Shift+F9`), **all** `vrAtlasX`/`vrAtlasY` values are cleared for every widget. The intent is to force the shelf-packing centering logic to apply fresh, but the side effects are:

1. If the user had already positioned widgets in a previous edit session, all that work is lost.
2. If the user enters and exits edit mode without moving any widget, `saveVrEditPositions()` only saves the currently-selected widget (`selectedWidgetId`). All other widgets lose their saved positions permanently (they'll be shelf-packed on next startup).
3. The positions are cleared from the in-memory `currentDashboard` but NOT persisted to disk — so on app restart, the old positions come back from disk. This creates an inconsistency between what the user sees in the current session vs. what loads next time.

**Fix:**
- Remove the blanket reset. Shelf-packing already handles unpositioned widgets via the `vrAtlasX != null` check in `VrAtlasContainer.tsx:82`.
- Only clear position for the currently-selected widget if the user explicitly resets it.
- Or add a "Reset all positions" action instead of doing it automatically.

---

## 3. Misleading text in VR Settings UI

**Severity: Medium | File: `src/frontend/components/Settings/sections/VrSettings.tsx:49-50`**

```tsx
Requires launching the app with IRDASHIES_VR=1.
```

The code in `isVrOverlayEnabled()` (`vrOverlay.ts:287-289`) only checks `process.platform === 'win32'`. The environment variable `IRDASHIES_VR` is referenced in `launch-vr.bat` but never actually checked in code. This text confuses users into thinking they need a special launch flag.

**Fix:**
- Remove the text, or change it to reflect actual behavior (e.g., "Windows only. Enable the toggle and restart iRacing.").
- Alternatively, implement the env var gate and update the text accordingly.

---

## 4. OSR atlas texture uses full primary display resolution

**Severity: Medium | File: `src/app/vr/vrOverlay.ts:380-387`**

```typescript
const { width: displayW, height: displayH } = screen.getPrimaryDisplay().size;
const texW = displayW;
const texH = displayH;
```

The offscreen `BrowserWindow` is created at the primary monitor's native resolution. On a 4K display this means a 3840x2160 texture that Chromium must composite at 60fps, and the native addon must copy to shared GPU memory every frame. The quad in VR is physically small (1.8m wide default), so this resolution is wasteful for both GPU memory and PCIe bandwidth.

**Fix:**
- Cap the atlas resolution (e.g., 1920x1080 or 2560x1440 max) and scale down.
- Or make it configurable in VR settings.
- The `zoomFactor` variable at line 383 is declared but always `1` — it could be used to render at a lower CSS resolution while keeping the texture smaller.

---

## 5. No display-change handling for atlas dimensions

**Severity: Medium | File: `src/app/vr/vrOverlay.ts:260-262`**

```typescript
let quadAspect = 9 / 16;
let atlasTexW = 1920;
let atlasTexH = 1080;
```

These module-level variables are captured once at startup from `screen.getPrimaryDisplay()`. If the user hotplugs a monitor, changes resolution, or switches primary display while VR is running, these values become stale. The `publishVrLayers()` function uses them for the `sourceRect`, which would be incorrect after a display change.

**Fix:**
- Listen for `screen` `display-added` / `display-removed` / `display-metrics-changed` events and update these variables.
- Or recalculate them on each `publishVrLayers()` call instead of caching.

---

## 6. Edit mode keyboard shortcuts orphaned after exit

**Severity: Low | File: `src/app/vr/vrOverlay.ts:83-108`**

`registerEditKeys()` calls `globalShortcut.unregister(accel)` before `globalShortcut.register(accel, handler)` for `Space`, `Left`, `Right`, `Up`, `Down`, `Q`, `E`. These keys may have been registered by `KeybindingManager` for other purposes.

When edit mode exits, `unregisterEditKeys()` unregisters them, but does NOT re-register whatever was there before. The keys remain unbound for the rest of the app session.

**Fix:**
- Save the previous handler state before overriding, and restore on exit.
- Or use Electron's `webContents.beforeInputEvent` instead of global shortcuts to avoid stealing from other subsystems.

---

## 7. `vrAtlasBridge` contextBridge dead code

**Severity: Low | File: `src/app/rendererExpose.ts` (and `src/interface.d.ts`)**

The `vrEditBridge` was intended for main-to-renderer communication via `contextBridge.exposeInMainWorld`, but it never worked (contextBridge silent failure, documented in `docs/vr/15-single-quad-edit-mode-summary.md`). The actual edit-mode communication uses `osrWindow.webContents.executeJavaScript()` + `CustomEvent` instead. The dead `vrEditBridge` code remains (wrapped in try-catch).

**Fix:**
- Remove the dead `vrEditBridge` code from `rendererExpose.ts` and `interface.d.ts`.
- Document the `executeJavaScript` + `CustomEvent` pattern as the official approach.

---

## 8. `registerVrLayer` early-bail can miss stale registrations

**Severity: Low | File: `src/app/vr/vrOverlay.ts:308-319`**

The function checks if the DLL exists AND the registry key exists. If both are present, it returns early. However, if the DLL exists but the registry key points to a stale path (e.g., a previous install location), it will still bail. Similarly, if the DLL was updated (new version) but the registry still references the old one, the update is never applied.

**Fix:**
- Compare the registered DLL path against `dllDest` to detect drift.
- Or always re-run the registration to ensure consistency (the PowerShell script uses `-Force` flags).

---

## 9. No VR-specific widget sorting preference

**Severity: Low | File: `src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx:51`**

```typescript
.sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x)
```

Widgets are sorted by their desktop layout position. If the user has widgets on multiple monitors with overlapping Y coordinates, the VR atlas order may not match their mental model. There's no way to reorder widgets specifically for VR.

**Fix:**
- Add a `vrOrder` field to `DashboardWidget` for explicit VR ordering.
- Or use the widget list order as-is (the order in `currentDashboard.widgets`) which the user can control by adding/removing widgets.

---

## 10. `showOnlyWhenOnTrack` not respected in VR

**Severity: Low | File: `src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx:133`**

The desktop overlay respects `widget.config.showOnlyWhenOnTrack` — widgets hide when the car is in the pits. In VR, the condition is only `running || widget.alwaysEnabled`; the `showOnlyWhenOnTrack` flag is not checked. Widgets that should hide in the pits remain visible in VR.

**Fix:**
- Pass the `onTrack` telemetry value to `VrAtlasContainer` and add it to the visibility condition.
- Or handle it in the individual widget component (as desktop does).

---

## Summary of actions

| # | Issue | Fix complexity | User-facing |
|---|-------|---------------|-------------|
| 1 | No error feedback on layer registration failure | Medium | Yes — error banner |
| 2 | Edit mode resets all saved positions | Low | Yes — data loss |
| 3 | Misleading `IRDASHIES_VR=1` text | Trivial | Yes — UI text |
| 4 | Atlas uses full display resolution | Medium | Yes — perf |
| 5 | No display-change handling | Low | Possible glitch |
| 6 | Edit mode shortcuts orphaned | Low | Minor UX |
| 7 | Dead contextBridge code | Trivial | No |
| 8 | Stale layer registration not detected | Low | Rare edge case |
| 9 | No VR-specific widget ordering | Medium | Yes — new UI/field |
| 10 | `showOnlyWhenOnTrack` not respected in VR | Low | Minor UX |
