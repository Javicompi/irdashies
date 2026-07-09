# 01 — Triple-buffer ring (shared texture + SHM)

## Problem

The current pipeline publishes a **single** shared texture + a **single** fence
value over SHM:

- `src/app/vr/native/vr_overlay.cc:72` — one `sharedTexture`.
- `native/shared/irdashies_shm.h:40-42` — one `textureHandle`, one `fenceHandle`,
  one `fenceValue`. No array, no ring index.

The fence guarantees the producer's **copy** of frame N finished. It does **not**
prevent the producer from starting to overwrite that same texture with frame N+1
while the game's GPU is still sampling frame N during its (long) `xrEndFrame`
composition. Result under iRacing load: **partial tearing / mid-frame
corruption** of the overlay.

The design docs (`vr-openxr-design.md:57`, `vr-website-rendering.md:35`) promise
"ring buffer, ~3 frames" and "triple-buffered", but the code never implements
it. This is the **highest-priority correctness bug**.

## Goal

A ring of `N` (3) shared textures. The producer writes to the next slot while
the consumer reads the most recently **completed** slot. They never touch the
same texture in the same frame, so no tearing even when the game frame is slow.

## Approach (step by step)

### 1. Extend the SHM contract (`native/shared/irdashies_shm.h`)

Add a per-slot frame table and ring indices. Keep a **single** shared fence with
monotonically increasing values (standard pattern — one fence, N textures).

```c
#define IRDASHIES_SHM_RING_SIZE 3u
#define IRDASHIES_SHM_MAX_LAYERS 16u  // used by #04, define now to avoid re-layout

struct IrdashiesShmFrameSlot {
  uint64_t textureHandle;  // NT handle to THIS slot's shared texture (producer PID)
  uint32_t width;
  uint32_t height;
  uint32_t format;         // DXGI_FORMAT
  uint64_t frameNumber;    // frame stored in this slot; 0 = never written
};

struct IrdashiesShmHeader {
  uint32_t magic;
  uint32_t version;        // bump to 2 + rename mapping/mutex (v2) on layout change
  uint32_t feederProcessId;
  uint32_t flags;
  int64_t  adapterLuid;

  uint64_t fenceHandle;    // single shared fence (NT handle, producer PID)
  uint64_t fenceValue;     // latest signalled value (matches frames[latestIndex])

  uint32_t writeIndex;     // producer's NEXT slot to write (0..N-1)
  uint32_t latestIndex;    // slot index of the most recent COMPLETED frame
  uint32_t ringSize;       // == IRDASHIES_SHM_RING_SIZE (consumer sanity check)

  IrdashiesShmFrameSlot frames[IRDASHIES_SHM_RING_SIZE];

  uint32_t recenterCounter;
  // pose fields stay shared for MVP (per-layer pose arrives in #04)
  float posePosition[3];
  float poseOrientation[4];
  float quadSizeMeters[2];
};
```

**Versioning**: bump `IRDASHIES_SHM_VERSION` to 2 and change
`IRDASHIES_SHM_MAPPING_NAME` / `MUTEX_NAME` to `...-v2` so an old consumer
never misreads a new producer (the header comment at `irdashies_shm.h:8-10`
mandates this).

### 2. Producer (`src/app/vr/native/vr_overlay.cc`)

Replace the single `sharedTexture`/`textureHandle`/`width`/`height`/`format`
fields with a ring of slots in `State`:

```c
struct Slot {
  ID3D11Texture2D* texture = nullptr;
  HANDLE handle = nullptr;
  uint32_t width = 0, height = 0;
  DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
};
Slot slots[IRDASHIES_SHM_RING_SIZE];
uint32_t writeIndex = 0;
```

In `SubmitFrame`, after computing `vw/vh/format` from the source texture:

1. `writeIndex = (g.writeIndex + 1) % N` — advance to the next slot **first**
   so `latestIndex` keeps pointing at the frame the consumer may be reading.
2. Ensure `slots[writeIndex]` exists and matches `vw/vh/format` (the existing
   create-or-recreate block at `vr_overlay.cc:303-344`, but per-slot). If you
   recreate it, the handle changes → publish the new handle into
   `shm->frames[writeIndex].textureHandle`.
3. `CopySubresourceRegion` into `slots[writeIndex].texture` (replaces
   `vr_overlay.cc:346-353`).
4. `++fenceValue; context4->Signal(fence, fenceValue); context->Flush();`
   (unchanged, `vr_overlay.cc:356-358`).
5. Under the mutex, publish:
   - `shm->frames[writeIndex].{textureHandle,width,height,format,frameNumber}`
     where `frameNumber = ++g.frameCounter`.
   - `shm->fenceValue = fenceValue`.
   - `shm->latestIndex = writeIndex`.
   - `shm->flags |= FEEDER_ATTACHED`.

`teardown()` releases all `slots[i].texture` and closes all `slots[i].handle`.

### 3. Consumer (`native/openxr-layer/src/layer.cpp`)

Replace the single `sharedTexture`/`sharedSrv`/`feederPid`/`texHandleVal` cache
with a per-slot cache so we don't `OpenSharedResource1` every frame:

```c
struct SlotView {
  uint64_t texHandleVal = 0;  // handle value this view was opened from
  ID3D11Texture2D* texture = nullptr;
  ID3D11ShaderResourceView* srv = nullptr;
};
SlotView slotViews[IRDASHIES_SHM_RING_SIZE];
uint64_t fenceHandleVal = 0;
ID3D11Fence* fence = nullptr;
```

In `my_xrEndFrame`:

1. `readShmFrame` → snapshot of the header.
2. `idx = frame.latestIndex; slot = frame.frames[idx]`.
3. If `slotViews[idx].texHandleVal != slot.textureHandle` (or producer PID
   changed), `OpenProcess` + `DuplicateHandle` the texture handle and
   `OpenSharedResource1` into `slotViews[idx]` (the existing
   `ensureSharedResources` logic at `layer.cpp:325-396`, but per-slot). Close
   the dup after open (`layer.cpp:382-384`).
4. Open the **fence** once (when `fenceHandleVal != frame.fenceHandle`); reuse
   across frames and slots.
5. `context4->Wait(fence, frame.fenceValue)` — guarantees the slot's copy is
   done before we sample it. Because the producer only signals **after** the
   copy completes and only then updates `latestIndex`, the wait is almost always
   already satisfied (no stall).
6. Blit from `slotViews[idx].srv` into the swapchain (unchanged blit code,
   `layer.cpp:529-551`).

### 4. Edge case: ring overrun

If the producer laps the consumer (writes 3+ frames before the consumer reads
once), it will overwrite a slot the consumer still shows. With producer at 60 Hz
and iRacing at 90-120 Hz the consumer is always ahead, so this won't happen in
practice. Document it. A hard guard (producer skips a slot the consumer hasn't
consumed) needs a back-channel from consumer → not worth it for MVP.

## Code touch points

| File | Change |
| --- | --- |
| `native/shared/irdashies_shm.h` | New slot table + ring indices; bump v2. |
| `src/app/vr/native/vr_overlay.cc` | `State.slots[N]`, per-slot create/copy/publish. |
| `native/openxr-layer/src/layer.cpp` | `SlotView[N]` cache, per-slot open, fence reused. |
| `native/shm-test-producer/src/producer.cpp` | Update to publish the ring (test harness must match the new contract). |
| `native/shm-test-producer/src/probe.cpp` | Read `latestIndex` + wait fence for that slot. |

## References

- OpenKneeboard reference (cited by `vr-website-rendering.md:35` as
  `SHM.hpp:36` `SwapChainLength` frames, and `:107` `SHM::Writer::SubmitFrame`):
  https://github.com/OpenKneeboard/OpenKneeboard — look for the `SHM` namespace
  (`src/dll/SHM.h` / `SHM.cpp`) for a production ring-buffer + fence
  implementation.
- D3D11 fences + shared NT handles:
  https://learn.microsoft.com/en-us/windows/win32/api/d3d11_4/nf-d3d11_4-id3d11device5-createfence
- Cross-process shared textures:
  https://learn.microsoft.com/en-us/windows/win32/direct3darticles/surface-sharing

## How to test

1. **Unit/transport (no headset)** — extend `irdashies-shm-probe`:
   - Open the ring, loop reading `latestIndex`, `Wait` on the fence for
     `fenceValue`, copy the slot's texture to a staging texture, read back
     pixels.
   - Run the updated test producer (which now rotates slots) and confirm the
     probe sees **every** `frameNumber` in order with no gaps and no stale
     repeats (i.e. it always reads the slot that matches the published
     `fenceValue`).
2. **Tearing stress (no headset)** — make the probe intentionally **slow**
   (sleep 50 ms between reads) so the producer laps it. Confirm the probe still
   reads a **coherent** frame each time (pixels match one producer frame
   exactly), never a half-old/half-new mix. This is the test that fails today.
3. **In-headset** — run the real Electron producer + iRacing with the layer.
   Drive a session with heavy GPU load (full grid, dusk, high settings) and
   verify the overlay never tears or flashes partial content during frame
   drops. Compare against the pre-ring build.
4. **Log check** — producer logs `created shared texture` once per slot at
   startup (3 lines), then `first frame published`. Consumer logs
   `Opened shared texture ... from producer PID` once per slot. No per-frame
   handle-open spam after warmup.
