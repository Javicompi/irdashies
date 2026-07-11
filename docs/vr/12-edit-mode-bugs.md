# 12 — VR edit mode: F9 not working + hide/show UI broken

Two regressions appeared after implementing the VR edit mode (#11).

## Problem 1 — F9 does not activate VR edit mode

### Symptom

Pressing F9 while VR is active does nothing: no instructions overlay, no green
border, no log output.

### Root cause

`registerVrEditKeys` in `src/app/vr/vrOverlay.ts:202-205` does not check the
return value of `globalShortcut.register`:

```typescript
export function registerVrEditKeys(): void {
  if (!globalShortcut.isRegistered('F9')) {
    globalShortcut.register('F9', toggleVrEditMode);
    // ← return value (boolean) not checked
  }
}
```

Electron's `globalShortcut.register` returns `false` when registration fails
(another app has the key, OS-level conflict, etc.). The current code silently
ignores the failure — no log, no fallback. Compare with
`KeybindingManager.registerAll` (`src/app/keybindingManager.ts:179-183`), which
**does** check and logs an error.

Additionally, `toggleVrEditMode` has no entry log, so even if F9 fires, there's
no way to confirm the callback ran.

### Why `reloadBindings` is NOT the cause

`KeybindingManager.reloadBindings` (`keybindingManager.ts:258-262`) calls
`unregisterAll` then `registerAll`. `unregisterAll` only unregisters
accelerators present in `this.bindings` (the keybindings map). F9 is not in that
map — it's registered separately by `registerVrEditKeys`. So `reloadBindings`
never touches F9. This was verified by reading `unregisterAll`
(`keybindingManager.ts:196-210`): it iterates `Object.values(this.bindings)`
and F9 is not one of them.

### Fix

**File:** `src/app/vr/vrOverlay.ts`

1. Check the return value and log:

```typescript
export function registerVrEditKeys(): void {
  if (!globalShortcut.isRegistered('F9')) {
    const ok = globalShortcut.register('F9', toggleVrEditMode);
    if (!ok) {
      logger.error('[VR] Failed to register F9 for edit mode');
    } else {
      logger.info('[VR] F9 registered for edit mode');
    }
  }
}
```

2. Add an entry log to `toggleVrEditMode`:

```typescript
function toggleVrEditMode(): void {
  logger.info('[VR] F9 pressed (osrWindow=%s)', osrWindow ? 'exists' : 'null');
  if (!osrWindow || osrWindow.isDestroyed()) return;
  // ... rest unchanged
}
```

### How to debug

1. Start the app with `IRDASHIES_VR=1`.
2. Check `irdashies-vr-producer.log` (or the main process console) for:
   - `[VR] F9 registered for edit mode` → registration succeeded.
   - `[VR] Failed to register F9 for edit mode` → registration failed. Another
     app may have F9. Check with `globalShortcut.isRegistered('F9')` in a
     debug REPL.
3. Press F9 and check for:
   - `[VR] F9 pressed (osrWindow=exists)` → the callback ran. If edit mode
     still doesn't activate, the issue is downstream (IPC send, React state).
   - No log → F9 is not reaching the callback. Registration failed or the key
     is consumed by the OS before Electron sees it.
4. If registration fails, check whether another irDashies instance or another
   app (e.g. iRacing itself, OBS, Discord overlay) has F9 registered. F9 is
   not in iRacing's default keymap, but third-party tools may use it.

---

## Problem 2 — Hide/show UI (Alt+H) broken when VR is active

### Symptom

Pressing Alt+H (the default `toggle-hide-ui` keybinding) while VR is active
does nothing. Before the VR changes, it toggled overlay visibility.

### Root cause

P1 (VR-only mode, `docs/vr/10-performance-double-render.md`) closes the desktop
overlay windows when VR starts (`overlayManager.suppressDesktopOverlays()`).
The `toggle-hide-ui` handler broadcasts `global-toggle-hide` to all windows
(`keybindingManager.ts:36-39`):

```typescript
this.actionHandlers.set('toggle-hide-ui', () => {
  this.hideState = !this.hideState;
  this.overlayManager.broadcastToAll('global-toggle-hide', this.hideState);
});
```

`broadcastToAll` sends to display windows (all closed) + external windows
(the OSR VR window). The OSR window receives the IPC, but the VR atlas page
(`VrAtlasApp` in `App.tsx:62-69`) does **not** wrap its content in
`HideUIWrapper`:

```tsx
// App.tsx:62-69 — VrAtlasApp has NO HideUIWrapper
const VrAtlasApp = () => (
  <ThemeManager>
    <VrAtlasContainer />
  </ThemeManager>
);

// App.tsx:46-59 — OverlayApp HAS HideUIWrapper
const OverlayApp = () => (
  <HideUIWrapper>
    <ProfileSwitchOverlay>
      <ThemeManager>
        <OverlayContainer />
      </ThemeManager>
    </ProfileSwitchOverlay>
  </HideUIWrapper>
);
```

`HideUIWrapper` (`HideUIWrapper.tsx:18-33`) subscribes to `globalKey.onToggle`
(IPC `global-toggle-hide`) and hides its children when `hide` is true. Without
it, the VR atlas page ignores the toggle entirely. The keybind fires
correctly (the handler runs), but nothing listens to it on the VR side.

### Fix

**File:** `src/frontend/App.tsx`

Wrap `VrAtlasContainer` in `HideUIWrapper`:

```tsx
const VrAtlasApp = () => (
  <HideUIWrapper>
    <ThemeManager>
      <VrAtlasContainer />
    </ThemeManager>
  </HideUIWrapper>
);
```

Add the import at the top (it's already imported for `OverlayApp` at line 14):

```typescript
import { HideUIWrapper } from './components/HideUIWrapper/HideUIWrapper';
```

No other changes needed. `HideUIWrapper` works with `window.globalKey.onToggle`,
which is exposed by `rendererExpose.ts:17-23` and is available in the OSR
window's preload.

### How to test

1. Start the app with `IRDASHIES_VR=1`.
2. Press Alt+H. Confirm the VR overlay disappears (the quad goes blank/empty in
   the headset).
3. Press Alt+H again. Confirm the overlay reappears.
4. Confirm the edit-mode F9 still works after toggling hide/show (hide/show
   should not interfere with edit mode).

---

## Summary

| Problem | Root cause | Fix | File |
| --- | --- | --- | --- |
| F9 does nothing | `globalShortcut.register` return value not checked; no logging | Check return + log; add entry log to `toggleVrEditMode` | `src/app/vr/vrOverlay.ts` |
| Alt+H does nothing | `VrAtlasApp` missing `HideUIWrapper` | Wrap `VrAtlasContainer` in `HideUIWrapper` | `src/frontend/App.tsx` |

Both fixes are small (2-3 lines each) and low-risk. The F9 fix is mostly
diagnostic (logging) — the actual root cause will be revealed by the log
output when testing.