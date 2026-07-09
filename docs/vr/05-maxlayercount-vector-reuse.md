# 05 — Respect `maxLayerCount` + reuse the layer vector

## Problem

Two issues in `my_xrEndFrame` (`native/openxr-layer/src/layer.cpp:604-611`):

1. **No `maxLayerCount` check.** The layer blindly appends its quad(s) to the
   game's layer list. If iRacing already uses several composition layers, the
   total can exceed `XrSystemGraphicsProperties::maxLayerCount`, after which
   `xrEndFrame` may fail or the runtime may drop layers unpredictably.
2. **Per-frame heap allocation.** A `std::vector<const XrCompositionLayerBaseHeader*>`
   is constructed and copied from the game's layers **every** `xrEndFrame`
   (90-120 Hz). Small, but pointless churn on the render thread of an
   already-busy sim.

## Goal

- Query and cache `maxLayerCount` once per session.
- Reuse a single reserved vector (no per-frame allocation).
- Never append more layers than the runtime allows; drop our own layers first
  (the game's layers always win).

## Approach (step by step)

### 1. Load `xrGetSystemProperties`

It isn't in the dispatch table today (`layer.cpp:773-789` `LOAD` block). Add
it:

```c
static PFN_xrGetSystemProperties g_next_xrGetSystemProperties = nullptr;
// in LOAD block:
LOAD(xrGetSystemProperties);
```

`XrSessionCreateInfo` carries `systemId`, and we have the `instance` from
`my_xrCreateApiLayerInstance`'s out-param — capture it:

```c
static XrInstance g_instance = XR_NULL_HANDLE;
// in my_xrCreateApiLayerInstance, after *instance is populated:
g_instance = *instance;
```

### 2. Query `maxLayerCount` in `my_xrCreateSession`

After the real `xrCreateSession` succeeds and before we set up our resources:

```c
XrSystemProperties sp{XR_TYPE_SYSTEM_PROPERTIES};
if (XR_SUCCEEDED(g_next_xrGetSystemProperties(g_instance, createInfo->systemId, &sp))) {
  g.maxLayerCount = sp.graphicsProperties.maxLayerCount;
  layerLog("Runtime maxLayerCount = %u", g.maxLayerCount);
} else {
  g.maxLayerCount = 0;  // unknown -> be conservative, assume 1
}
```

Add to `SessionState`:
```c
uint32_t maxLayerCount = 0;
```

The spec doesn't guarantee a minimum > 1, but in practice runtimes report a
small number (often 4-16). Treat 0/unknown as "only our single fallback quad
is safe".

### 3. Reserve a reused vector in `SessionState`

Replace the local vector in `my_xrEndFrame` with a member:

```c
// in SessionState:
std::vector<const XrCompositionLayerBaseHeader*> outLayers;
```

Reserve once (in `my_xrCreateSession` after we know `maxLayerCount`, or lazily
on first frame):

```c
g.outLayers.reserve(/* game max + our max */ 32);
```

### 4. Fill without reallocating each frame

In `my_xrEndFrame`, replace `layer.cpp:604-611`:

```c
g.outLayers.clear();
const auto* gameLayers = frameEndInfo->layers;
for (uint32_t i = 0; i < frameEndInfo->layerCount; ++i)
  g.outLayers.push_back(gameLayers[i]);

// Our budget = maxLayerCount - gameLayerCount (never negative)
const uint32_t gameLayerCount = frameEndInfo->layerCount;
const uint32_t ourBudget = (g.maxLayerCount > gameLayerCount)
    ? (g.maxLayerCount - gameLayerCount) : 0;

// Append up to ourBudget of our quads (see #04 for the quads array).
uint32_t appended = 0;
for (uint32_t i = 0; i < ourQuads.size() && appended < ourBudget; ++i) {
  g.outLayers.push_back(reinterpret_cast<const XrCompositionLayerBaseHeader*>(&ourQuads[i]));
  ++appended;
}
if (appended < ourQuads.size()) {
  // log once: we exceeded the runtime's layer budget
}

XrFrameEndInfo patched = *frameEndInfo;
patched.layerCount = (uint32_t)g.outLayers.size();
patched.layers = g.outLayers.data();
return g_next_xrEndFrame(session, &patched);
```

`clear()` + `push_back` on a reserved vector does **not** reallocate (capacity
stays), so there's no heap traffic on the hot path.

### 5. Ordering / priority

The game's own layers are copied first and always kept. Our overlay layers are
appended after and dropped first when over budget. This matches user
expectation: the sim's rendering is never degraded by the overlay.

### 6. Don't append if there's nothing to show

If `ourQuads` is empty (no producer, and we've decided not to show the
fallback in this frame — see #07), skip the copy entirely and pass
`frameEndInfo` through unmodified. That avoids even the `clear()`/copy of the
game's layers on the common "nothing to do" path:

```c
if (ourQuads.empty()) return g_next_xrEndFrame(session, frameEndInfo);
```

## Code touch points

| File | Change |
| --- | --- |
| `native/openxr-layer/src/layer.cpp` | Load + hook `xrGetSystemProperties`; capture `g_instance`; query `maxLayerCount` in `my_xrCreateSession`; reuse `outLayers` in `my_xrEndFrame`; budget check. |

## References

- `XrSystemProperties` / `XrSystemGraphicsProperties::maxLayerCount`:
  https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html#XrSystemGraphicsProperties
- OpenKneeboard respects `mMaxLayerCount` (`vr-website-rendering.md:58` cites
  `:262`): https://github.com/OpenKneeboard/OpenKneeboard
- `xrEndFrame` layer limits:
  https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html#xrEndFrame

## How to test

1. **Synthetic low-limit runtime** — there's no easy way to force a real
   runtime to report a tiny `maxLayerCount`, so unit-test the budget logic by
   extracting it: given `(gameLayerCount, maxLayerCount, ourQuadsCount)`,
   assert the appended count is `min(ourQuadsCount, max(0, maxLayerCount -
   gameLayerCount))`. Cover: budget 0, budget > our quads, budget < our quads,
   game already at limit.
2. **Log inspection** — `irdashies-openxr-layer.log` prints
   `Runtime maxLayerCount = N` on session create. With #04 producing several
   quads, confirm we never append more than `N - gameLayerCount`.
3. **No allocation on hot path** — run a long session under a profiler
   (VS Performance Profiler / ETW) and confirm `my_xrEndFrame` does **not**
   show a per-frame `std::vector` allocation after the first few frames
   (reserve holds). Compare against the current build, which allocates every
   frame.
4. **Over-budget drop is graceful** — if you can get iRacing to emit many
   layers (some sims use a layer per eye element), confirm the overlay simply
   stops adding quads when over budget, with no `xrEndFrame` error logged and
   no crash.
