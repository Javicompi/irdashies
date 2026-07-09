# 03 — Gate the OpenXR layer to iRacing

## Problem

The layer is an **implicit** API layer registered under HKLM, so while
registered it injects into **every** OpenXR D3D11 application — not just
iRacing. The design doc (`vr-openxr-design.md:68`) calls this out as the
**"main risk mitigation"**: it turns "could break any VR game" into "only
touches iRacing". The README admits it's not implemented
(`native/openxr-layer/README.md:89`).

Today any other VR title on the user's machine gets a quad appended to its
frame (or the animated fallback pulse) and pays the per-frame SHM read +
swapchain cost. That is a support and reputation hazard.

## Goal

If the host process is not `iRacingSim64DX11.exe`, the layer becomes a pure
pass-through: it hooks nothing that matters, creates no D3D11 resources, adds
no layers, and ideally returns the real function pointers directly so there is
zero per-call overhead.

## Approach (step by step)

### 1. Detect the host process early

The earliest reliable hook is `my_xrCreateApiLayerInstance`
(`layer.cpp:757`). Use `GetModuleFileNameW(NULL, ...)` to get the host EXE
path and compare the basename case-insensitively:

```c
static bool g_gatedOff = false;  // true = not iRacing, do nothing

static bool hostIsIRacing() {
  wchar_t path[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, path, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return false;
  // basename
  wchar_t* base = path;
  for (wchar_t* p = path; *p; ++p) if (*p == L'\\' || *p == L'/') base = p + 1;
  // case-insensitive compare
  return _wcsicmp(base, L"iRacingSim64DX11.exe") == 0;
}
```

Set `g_gatedOff = !hostIsIRacing()` at the top of
`my_xrCreateApiLayerInstance`, **before** calling the next layer. Log the
result so a misconfigured install is diagnosable:

```c
layerLog("Host process gate: %s (gatedOff=%d)",
         g_gatedOff ? "NOT iRacing -> pass-through" : "iRacing -> active");
```

### 2. Make `xrGetInstanceProcAddr` a pure pass-through when gated off

In `my_xrGetInstanceProcAddr` (`layer.cpp:737-755`), short-circuit before the
name comparisons:

```c
static XrResult XRAPI_CALL my_xrGetInstanceProcAddr(
    XrInstance instance, const char* name, PFN_xrVoidFunction* function) {
  if (!g_nextGetInstanceProcAddr) return XR_ERROR_HANDLE_INVALID;
  if (g_gatedOff) return g_nextGetInstanceProcAddr(instance, name, function);
  // ... existing intercept logic ...
}
```

This means the app gets the **real** `xrCreateSession`/`xrEndFrame`/etc. with
no layer wrapper at all — zero overhead.

### 3. Guard the session/endframe paths too (defence in depth)

Even with step 2, gate the body of `my_xrCreateSession` and `my_xrEndFrame` on
`!g_gatedOff` so a future code path that loads function pointers directly
can't accidentally activate the layer:

- `my_xrCreateSession` (`layer.cpp:617`): if `g_gatedOff`, just
  `return g_next_xrCreateSession(...)`.
- `my_xrEndFrame` (`layer.cpp:473`): if `g_gatedOff`, just
  `return g_next_xrEndFrame(...)`.

### 4. Optional: allow a manual override

Add an env var for testing/debug so the layer can be forced on for non-iRacing
OpenXR apps (e.g. Khronos `hello_xr`):

```c
if (GetEnvironmentVariableW(L"IRDASHIES_OPENXR_FORCE_ON", nullptr, 0) != 0) {
  g_gatedOff = false;
  layerLog("IRDASHIES_OPENXR_FORCE_ON set -> layer active regardless of host");
}
```

Keep `DISABLE_IRDASHIES_OPENXR` (the manifest's `disable_environment`,
`irDashies-OpenXR.json.in:12`) as the hard off switch — it stops the loader
from loading the layer at all. The gate is a *runtime* filter on top of that.

### 5. Don't break multi-instance / iRacing UI processes

iRacing has helper processes (`iRacingUI.exe`, etc.). The sim itself is
`iRacingSim64DX11.exe` (DX11) — that's the only one with an OpenXR session, so
matching that exact name is correct. Do **not** match `iRacing*.exe` loosely,
or you might inject into the UI.

## Code touch points

| File | Change |
| --- | --- |
| `native/openxr-layer/src/layer.cpp` | `g_gatedOff`, `hostIsIRacing()`, guards in negotiate/getProcAddr/createSession/endFrame, optional force-on env var. |

No SHM, producer, or build changes — this is consumer-only.

## References

- OpenXR API layers (implicit layers, `disable_environment`):
  https://registry.khronos.org/OpenXR/specs/1.1/loader.html#api-layer
- OpenKneeboard deliberately injects everywhere (no gate) — this fork's gate is
  a **deliberate divergence** from OpenKneeboard for safety, as called out in
  `vr-openxr-design.md:68`.
- Khronos `hello_xr` (D3D11) for testing non-iRacing hosts:
  https://github.com/KhronosGroup/OpenXR-SDK-Source

## How to test

1. **Non-iRacing host must be inert** — with the layer registered, launch
   Khronos `hello_xr` (D3D11) **without** `IRDASHIES_OPENXR_FORCE_ON`:
   - No quad appears; no fallback pulse.
   - `irdashies-openxr-layer.log` contains
     `Host process gate: NOT iRacing -> pass-through (gatedOff=1)`.
   - No `Session ready` / `Opened shared texture` lines (we never create
     resources).
   - RenderDoc or a frame capture shows no extra composition layer.
2. **iRacing host is active** — launch iRacing with OpenXR:
   - Log says `Host process gate: iRacing -> active (gatedOff=0)`.
   - With the producer running, the overlay appears normally.
3. **Force-on override** — launch `hello_xr` with `IRDASHIES_OPENXR_FORCE_ON=1`
   + the test producer; confirm the layer activates and the quad shows the
   producer pattern. This keeps `hello_xr` usable as a no-headset dev loop.
4. **Hard off switch** — set `DISABLE_IRDASHIES_OPENXR=1` and confirm the
   loader doesn't even load the layer (no log file, no negotiate line) for
   either host.
5. **No perf regression in other games** — with the gate on, measure
   `xrEndFrame` overhead in `hello_xr` vs. the layer unregistered; they should
   be indistinguishable (we return the real pointer, no wrapper).
