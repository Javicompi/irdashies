# 06 — Layer device/context robustness (own device vs. game's)

## Problem

The layer uses the **game's** D3D11 device and immediate context
(`native/openxr-layer/src/layer.cpp:640-644`). The README already flags this
(`native/openxr-layer/README.md:86-88`):

> "Uses the app's immediate D3D11 context — fine for now, but a real build
> should use its own device/context to avoid clobbering app pipeline state
> (OpenKneeboard does this)."

The current code **already mitigates** the worst case: it records the blit on a
**deferred** context and executes with `ExecuteCommandList(cmd, TRUE)` where
`TRUE` = `RestoreContextState`, so the game's immediate-context pipeline state
is restored (`layer.cpp:138-140`, `:545-551`). So this is **robustness / future-
proofing**, not an active bug. This doc explains what's left and when a fully
separate device is worth the cost.

## Goal

- Make the layer's GPU work **impossible** to disturb the game's render state.
- Enable multi-thread protection if the layer ever uses another thread.
- Document when a dedicated device pays off vs. the double-copy cost it
  imposes.

## Approach (step by step)

### 1. Keep the deferred-context path (already done) and harden it

- `CreateDeferredContext` at `layer.cpp:652` — keep. If it fails, the log
  warns (`:653-657`); consider **failing the session setup** instead, so we
  never silently fall back to mutating the game's immediate context. At
  minimum, gate the fallback-pulse clear (`layer.cpp:558`) to the deferred
  context too (currently it uses `g.context` directly).
- Always `ExecuteCommandList(cmd, TRUE)` (`:548`) — `TRUE` guarantees the
  game's prior state is restored. Keep.
- Clear SRV hazards on the deferred context (`layer.cpp:542-543`) — keep; this
  avoids a lingering reference to the shared texture.

### 2. Enable multi-thread protection on the game device

If the layer ever records work on a thread other than the game's render thread
(e.g. a future background decode/upload), the device must be multi-thread
protected. Do this defensively now — it's one call and harmless if unused:

```c
ID3D11Multithread* mt = nullptr;
if (SUCCEEDED(g.device->QueryInterface(IID_PPV_ARGS(&mt)))) {
  mt->SetMultithreadProtected(TRUE);
  mt->Release();
}
```

Add it in `my_xrCreateSession` after grabbing the device. (OpenKneeboard sets
this; it's cheap.)

### 3. Evaluate a dedicated device (the advanced option)

A fully separate device for the layer sounds cleaner, but it has a hard
constraint: **OpenXR swapchain images belong to the game's device**
(`XrSwapchainImageD3D11KHR.texture` are textures on the game device). So the
blit's destination **must** be on the game's device. A separate layer device
can only own the **source** side (opening the producer's shared texture). To
get pixels from the layer device to the game-device swapchain image you'd need:

1. Open producer texture on **layer device**.
2. Blit to a shared texture owned by the layer device.
3. Open that shared texture on the **game device**.
4. Blit (game device) shared texture → swapchain image.

That's **two** blits + a shared texture + a second device + a second context.
For a single fullscreen-triangle copy it is **not worth it** — the deferred +
`RestoreContextState` approach gives the same correctness guarantee at a
fraction of the cost.

**Recommendation: do not split devices for the blit.** Keep one device (the
game's), deferred context, `RestoreContextState=TRUE`, multi-thread on. This is
the pragmatic "real build" state.

### 4. When a dedicated device *would* pay off

Only if the layer starts doing heavy GPU work that could stall the game's
device queue — e.g.:
- GPU-side atlas compositing of many source textures (not our case; the atlas
  is built in the producer).
- Format conversion / scaling that's expensive (not our case; one triangle).
- Running on a separate thread with its own command queue.

None apply today. Revisit only if #04 grows into GPU-heavy compositing.

### 5. Adapter match (already handled, keep it)

`layer.cpp:336-347` rejects a producer/game LUID mismatch. Keep that gate; a
dedicated device wouldn't change it — both devices still need the **same
adapter** for `OpenSharedResource1` to work.

### 6. Don't hold the game's device refs longer than the session

`my_xrDestroySession` (`layer.cpp:713-732`) releases everything. Keep that
complete teardown; a leaked device ref keeps the game's D3D device alive after
shutdown.

## Code touch points

| File | Change |
| --- | --- |
| `native/openxr-layer/src/layer.cpp` | `SetMultithreadProtected(TRUE)`; route the fallback clear through the deferred context; (optionally) fail session setup if `CreateDeferredContext` fails. |

No SHM/producer changes.

## References

- `ID3D11Multithread::SetMultithreadProtected`:
  https://learn.microsoft.com/en-us/windows/win32/api/d3d11_4/nf-d3d11_4-id3d11multithread-setmultithreadprotected
- Deferred contexts + `ExecuteCommandList(RestoreState)`:
  https://learn.microsoft.com/en-us/windows/win32/direct3d11/overviews-direct3d-11-render-deferred
- OpenKneeboard uses the game device + deferred rendering (the README's note
  that OpenKneeboard "uses its own device" refers to its CEF/renderer side, not
  the swapchain blit which must use the game device):
  https://github.com/OpenKneeboard/OpenKneeboard
- Shared resources across devices (same adapter only):
  https://learn.microsoft.com/en-us/windows/win32/direct3darticles/surface-sharing

## How to test

1. **Game state integrity** — the real test is "does iRacing ever render
   wrongly while the overlay is active?" Run a heavy session and watch for:
   - Flickering / wrong colours in the sim (not the overlay).
   - Disappearing geometry (depth/blend state clobbered).
   - D3D11 debug-layer warnings. Enable the D3D debug layer in iRacing's device
     (or via the OpenXR runtime's debug) and confirm **no** warnings name the
     layer's deferred command list as corrupting state. With
     `RestoreContextState=TRUE` there should be none.
2. **Multithread toggle** — assert `SetMultithreadProtected` returns TRUE and
   the device reports protected=TRUE afterwards (`ID3D11Multithread::GetMultithreadProtected`).
3. **Fallback path uses deferred** — trigger the no-producer fallback and
   confirm (via the log + a RenderDoc capture) that the clear is recorded on
   the deferred context and submitted via `ExecuteCommandList`, not issued
   directly on the game's immediate context.
4. **Clean teardown** — start/stop iRacing's session many times; confirm via
   the D3D debug layer that no layer-held refs to the game device survive
   `xrDestroySession` (no "device still has live references" warnings).
5. **(If you ever try the dedicated-device path)** — benchmark the two-blit
   variant vs. the single deferred blit. Expect the single blit to win by a
   wide margin for the current workload; use that as the reason to stay on one
   device.
