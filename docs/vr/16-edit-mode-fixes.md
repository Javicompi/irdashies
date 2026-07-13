# 16 — VR edit mode fixes: centered atlas, position persistence, code cleanup

## Issues to fix (ordered by importance)

1. **Atlas not centered** — widgets shelf-pack with a 200px left margin but no
   right margin, so the movable area is asymmetric. Moving a widget left runs
   out of space quickly; moving right has lots of room. The user wants the
   atlas centered on their viewpoint.
2. **Position reset on edit-mode entry** — entering edit mode clears all
   saved `vrAtlasX`/`vrAtlasY`, so if the user enters, exits without moving
   anything, and re-enters, their saved layout is lost.
3. **`as any` casts** — `vrAtlasX: undefined as any` in the reset, and
   `(moveSelected as any)._zTimer` for the debounce timer. Fragile and
   lint-hostile.
4. **Dead `vrEditBridge` in preload** — the `contextBridge.exposeInMainWorld`
   code for `vrEditBridge` is unused (communication uses
   `executeJavaScript` + `CustomEvent`). Should be removed.
5. **Indentation** — some lines in `startVrOverlay` lost their indentation
   during edits.

---

## Fix 1 — Centered atlas (most important)

### Problem

The atlas is `atlasWidth` pixels wide (typically 1920, the display width).
`MARGIN_X = 200` is applied only to the left in the shelf-packer
(`VrAtlasContainer.tsx:62`), and movement is clamped to `[0, atlasTexW - 1]`
(`vrOverlay.ts:moveSelected`). So:

- A widget starts at x=200 (left margin).
- It can move left to x=0 (200px of room) or right to x=1919 (1719px of room).
- The user perceives this as "stuck on the left with lots of space to the
  right."

The root issue: the **quad's center** corresponds to the atlas center
(~960px), but the shelf-pack starts widgets at x=200, offsetting the visual
content to the left of the quad's center. There's no concept of "the center of
the user's view corresponds to the center of the atlas."

### Goal

The center of the user's field of view should map to the **center of the
populated content** in the atlas, not the center of the atlas texture. Widgets
should shelf-pack **centered** within the atlas, and the movement range should
be **symmetric** around that center.

### Fix

**File:** `src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx`

Replace the left-only margin with **centered shelf-packing**:

```tsx
const atlasWidth = window.innerWidth;

// Shelf-packing: center the row of widgets horizontally.
const slots = useMemo<AtlasSlot[]>(() => {
  const result: AtlasSlot[] = [];
  const padding = 4;

  // First pass: compute total width and height of all widgets (one row).
  // Simple approach: pack all in a single row, centered.
  // If they don't fit in one row, wrap to additional rows (each centered).
  const rows: AtlasSlot[][] = [];
  let currentRow: AtlasSlot[] = [];
  let currentRowWidth = 0;
  let currentRowH = 0;

  for (const w of vrWidgets) {
    const ww = w.layout.width;
    const wh = w.layout.height;

    // Use live/cached/saved position if available (not auto-pack).
    const cached = livePosCache.current.get(w.id);
    const hasPos = cached || (w.vrAtlasX != null && w.vrAtlasY != null);
    if (hasPos) {
      // This widget has an explicit position — don't auto-pack it.
      // Add it as-is (position resolved below).
      continue;
    }

    // Auto-pack: add to current row or start a new row.
    if (currentRowWidth + ww > atlasWidth && currentRow.length > 0) {
      rows.push(currentRow);
      currentRow = [];
      currentRowWidth = 0;
    }
    currentRow.push({ widgetId: w.id, x: 0, y: 0, width: ww, height: wh });
    currentRowWidth += ww + padding;
    currentRowH = Math.max(currentRowH, wh);
  }
  if (currentRow.length > 0) rows.push(currentRow);

  // Second pass: center each row and assign final positions.
  const MARGIN_Y = 100;  // top margin for the atlas
  let y = MARGIN_Y;
  for (const row of rows) {
    const rowWidth = row.reduce((sum, s) => sum + s.width, 0) +
                     padding * (row.length - 1);
    const startX = Math.max(0, Math.round((atlasWidth - rowWidth) / 2));
    let x = startX;
    for (const slot of row) {
      result.push({ ...slot, x, y });
      x += slot.width + padding;
    }
    y += row.reduce((max, s) => Math.max(max, s.height), 0) + padding;
  }

  // Third pass: add widgets with explicit positions (live/cached/saved).
  for (const w of vrWidgets) {
    const isSelected = editMode && w.id === selectedWidgetId;
    if (isSelected) {
      result.push({ widgetId: w.id, x: livePos.x, y: livePos.y,
                    width: w.layout.width, height: w.layout.height });
    } else {
      const cached = livePosCache.current.get(w.id);
      if (cached) {
        result.push({ widgetId: w.id, x: cached.x, y: cached.y,
                      width: w.layout.width, height: w.layout.height });
      } else if (w.vrAtlasX != null && w.vrAtlasY != null) {
        result.push({ widgetId: w.id, x: w.vrAtlasX, y: w.vrAtlasY,
                      width: w.layout.width, height: w.layout.height });
      }
      // (else: already auto-packed above)
    }
  }

  return result;
}, [vrWidgets, livePos, editMode, selectedWidgetId]);
```

This centers each row of auto-packed widgets within the atlas. Widgets with
explicit positions (from edit mode or saved) are placed at their exact
coordinates. The result: the initial layout is visually centered in the
user's field of view, and the movement range is symmetric.

**File:** `src/app/vr/vrOverlay.ts`

The movement clamp in `moveSelected` doesn't need changes — it already allows
`[0, atlasTexW - 1]`. With centered packing, a widget starting at ~800px (for
a 1920 atlas) has ~800px of room left and ~1120px right. If you want truly
symmetric movement around the center, clamp to the same margin on both sides:

```typescript
// In moveSelected, for X:
const MARGIN = 50;  // small safety margin on both sides
liveEditX = Math.max(MARGIN, Math.min(liveEditX + dx, atlasTexW - MARGIN - 1));
// And for Y:
liveEditY = Math.max(MARGIN, Math.min(liveEditY + dy, atlasTexH - MARGIN - 1));
```

This gives symmetric bounds: a widget can't go closer than 50px to any edge.
Combined with centered packing, the user perceives a centered, symmetric
workspace.

---

## Fix 2 — Don't reset positions on edit-mode entry

### Problem

`vrOverlay.ts:toggleVrEditMode` (around line 162-170) clears all
`vrAtlasX`/`vrAtlasY` when entering edit mode:

```typescript
if (currentDashboard) {
  currentDashboard = {
    ...currentDashboard,
    widgets: currentDashboard.widgets.map((w) => ({
      ...w,
      vrAtlasX: undefined as any,  // ← clears saved positions
      vrAtlasY: undefined as any,
    })),
  };
}
```

This was added so the centering logic applies fresh on each entry. But it
means: if the user enters edit mode, exits without moving anything, and
re-enters, their previously saved positions are gone.

### Fix

**Remove the reset.** The shelf-packer in `VrAtlasContainer` already handles
both cases:
- Widgets with `vrAtlasX`/`vrAtlasY` → placed at their saved position.
- Widgets without → auto-packed (centered, via Fix 1).

So entering edit mode should just read the current positions, not clear them:

```typescript
function toggleVrEditMode(): void {
  // ... debounce, guard ...
  vrEditMode = !vrEditMode;

  if (vrEditMode) {
    // DON'T reset positions — use what's saved or auto-pack.
    selectedWidgetIndex = 0;
    selectedWidgetId = atlasLayout[0]?.widgetId ?? null;
    if (selectedWidgetId) {
      const [x, y] = getWidgetAtlasPos(selectedWidgetId);
      liveEditX = x; liveEditY = y;
      liveEditZ = currentVrPose?.position?.[2] ?? DEFAULT_POSE.position[2];
    }
    registerEditKeys();
    logger.info('[VR] edit mode ON');
  } else {
    // ... existing exit logic ...
  }
  // ...
}
```

Also clear the `livePosCache` in React when entering edit mode, so the
renderer picks up the saved/auto positions fresh. Add a `vr-edit-state`
event with `active: true` that the handler already processes — the cache
should be populated from that event, not from stale data. The simplest
approach: in `VrAtlasContainer.tsx`, clear the cache when `editMode`
transitions from `false` to `true`:

```tsx
useEffect(() => {
  if (editMode) {
    livePosCache.current.clear();
  }
}, [editMode]);
```

This way, on entering edit mode, all widgets re-read from
`vrAtlasX`/`vrAtlasY` (or auto-pack), not from stale cache.

---

## Fix 3 — Remove `as any` casts

### `vrAtlasX: undefined as any` in toggle

With Fix 2 applied, this line is removed entirely (no reset). No cast needed.

### `(moveSelected as any)._zTimer` for debounce

**File:** `src/app/vr/vrOverlay.ts`

Replace the function-attached timer with a module-level variable:

```typescript
// Module-level (near the other let declarations):
let zMoveTimer: ReturnType<typeof setTimeout> | undefined;

function moveSelected(dx: number, dy: number, dz: number): void {
  if (!vrEditMode || !selectedWidgetId) return;

  if (dx !== 0 || dy !== 0) {
    const MARGIN = 50;
    liveEditX = Math.max(MARGIN, Math.min(liveEditX + dx, atlasTexW - MARGIN - 1));
    liveEditY = Math.max(MARGIN, Math.min(liveEditY + dy, atlasTexH - MARGIN - 1));
    notifyRenderer();
  }

  if (dz !== 0) {
    liveEditZ = Math.max(-4, Math.min(liveEditZ + dz, -0.5));
    if (!zMoveTimer) {
      zMoveTimer = setTimeout(() => {
        zMoveTimer = undefined;
        applyVrOverlaySettings({
          ...DEFAULT_VR_OVERLAY_SETTINGS,
          width: currentVrPose?.size?.[0] ?? DEFAULT_POSE.size[0],
          distance: -liveEditZ,
          horizontal: currentVrPose?.position?.[0] ?? 0,
          vertical: currentVrPose?.position?.[1] ?? 0,
        });
      }, 100);
    }
    notifyRenderer();
  }
}
```

Remove the old `(moveSelected as any)._zTimer = ...` line at the bottom.

Also clear the timer on exit to avoid a stray update after edit mode closes:

```typescript
function unregisterEditKeys(): void {
  // ... existing ...
  if (zMoveTimer) { clearTimeout(zMoveTimer); zMoveTimer = undefined; }
}
```

---

## Fix 4 — Remove dead `vrEditBridge` from preload

### Problem

`src/app/rendererExpose.ts` still has the `vrEditBridge` `contextBridge`
exposure (wrapped in try-catch), but it's unused — the actual communication
uses `executeJavaScript` + `CustomEvent`. The type declaration in
`src/interface.d.ts` and the try-catch wrapper are dead code.

### Fix

**File:** `src/app/rendererExpose.ts`

Remove the entire `vrEditBridge` block:

```typescript
// DELETE this block:
try {
  contextBridge.exposeInMainWorld('vrEditBridge', { ... });
} catch { ... }
```

**File:** `src/interface.d.ts`

Remove the `vrEditBridge` type:

```typescript
// DELETE:
vrEditBridge?: {
  onEditMode: ...;
  onSelect: ...;
  onMove: ...;
};
```

**File:** `src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx` and
`VrEditInstructions.tsx`

These already don't reference `window.vrEditBridge` (they use `CustomEvent`),
so no change needed.

---

## Fix 5 — Indentation in `startVrOverlay`

### Problem

Several lines in `startVrOverlay` (around line 300-310) lost their indentation
during edits:

```typescript
// Current:
overlayManager.suppressDesktopOverlays();

// Create the OSR window at the primary display size. Chromium OSR caps the
// framebuffer to the display resolution, so a larger window is wasted.
const { width: displayW, height: displayH } = screen.getPrimaryDisplay().size;
const texW = displayW;
```

These should be indented inside the function body.

### Fix

Re-indent the affected lines to match the surrounding function body (one
level of indentation). This is a pure formatting change — no logic change.

---

## Code touch points

| File | Changes |
| --- | --- |
| `src/frontend/components/VrAtlasContainer/VrAtlasContainer.tsx` | Centered shelf-packing (Fix 1); clear `livePosCache` on edit-mode entry (Fix 2) |
| `src/app/vr/vrOverlay.ts` | Remove position reset on entry (Fix 2); symmetric movement clamp (Fix 1); module-level `zMoveTimer` (Fix 3); indentation (Fix 5) |
| `src/app/rendererExpose.ts` | Remove dead `vrEditBridge` block (Fix 4) |
| `src/interface.d.ts` | Remove `vrEditBridge` type (Fix 4) |

---

## How to test

### Fix 1 — Centered atlas

1. Start VR with 3-5 enabled widgets, no saved positions. Confirm widgets
   appear **centered** in the headset (not pinned to the left).
2. Enter edit mode (Ctrl+Shift+F9). Select a widget. Move it left with
   arrow keys — confirm it can move a reasonable distance left before hitting
   the margin. Move it right — confirm symmetric distance.
3. Move a widget to the far left, then far right. Confirm the distance
   traveled is approximately the same in both directions.

### Fix 2 — Position persistence

1. Enter edit mode. Move 2 widgets to custom positions. Exit edit mode.
2. Re-enter edit mode. Confirm the widgets are at the positions you left them
   (not reset to centered auto-pack).
3. Exit edit mode, restart the app, re-enter edit mode. Confirm positions
   persist across restarts.

### Fix 3 — No `as any`

1. `npx eslint src/app/vr/vrOverlay.ts --max-warnings 0` passes with no
   `no-explicit-any` or `no-unused-vars` errors.
2. Enter edit mode, press Q/E rapidly. Confirm the debounce still works (no
   flood of `applyVrOverlaySettings` calls; the overlay moves smoothly).
3. Exit edit mode immediately after pressing Q/E. Confirm no stray
   `applyVrOverlaySettings` call fires after exit (the timer is cleared).

### Fix 4 — Dead code removed

1. `grep -r "vrEditBridge" src/` returns nothing.
2. The app starts and VR edit mode works as before (the `CustomEvent` path
   is unaffected).

### Fix 5 — Indentation

1. Visual inspection: the `startVrOverlay` function body is consistently
   indented.