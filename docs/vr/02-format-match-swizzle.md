# 02 — Format match / channel swizzle

## Problem

The consumer picks its swapchain format **without looking at the format the
producer actually published**:

- `native/openxr-layer/src/layer.cpp:401-414` `pickFormat()` iterates the
  runtime's supported formats in the fixed order
  `{R8G8B8A8_UNORM, B8G8R8A8_UNORM}` and returns the first hit.
- The blit pixel shader (`layer.cpp:259-263`) samples and returns the texel
  **as-is**, no swizzle.
- The producer **does** publish `format` (`irdashies_shm.h:46`,
  `vr_overlay.cc:342`), and Chromium OSR on Windows typically delivers
  **BGRA8**.

If the runtime lists `R8G8B8A8_UNORM` first (common) and the source is BGRA8,
the bytes `B,G,R,A` land in channels `R,G,B,A` → **red and blue are swapped**
in the headset. The layer README admits the in-headset blit is "not yet
confirmed", so this bug is likely latent.

## Goal

The swapchain format always matches the producer's source format, OR a cheap
shader swizzle compensates when the runtime can't provide that format. No
channel swap in any combination.

## Approach (step by step)

### 1. Prefer the producer's format in `pickFormat`

Change `pickFormat()` to take the source format and try it first:

```c
static int64_t pickFormat(DXGI_FORMAT srcFormat) {
  uint32_t count = 0;
  g_next_xrEnumerateSwapchainFormats(g.session, 0, &count, nullptr);
  std::vector<int64_t> formats(count);
  g_next_xrEnumerateSwapchainFormats(g.session, count, &count, formats.data());

  // 1) exact match with the producer's source format (no swizzle needed)
  for (int64_t f : formats) if (f == (int64_t)srcFormat) return f;
  // 2) the other common UNORM 8-bit format (we'll swizzle in the shader)
  for (int64_t want : {(int64_t)DXGI_FORMAT_B8G8R8A8_UNORM,
                       (int64_t)DXGI_FORMAT_R8G8B8A8_UNORM}) {
    for (int64_t f : formats) if (f == want) return f;
  }
  return formats.empty() ? (int64_t)DXGI_FORMAT_R8G8B8A8_UNORM : formats.front();
}
```

Call it as `g.swapchainFormat = pickFormat((DXGI_FORMAT)frame.format);` when a
real frame is available. For the no-producer fallback, keep the current
behaviour (any RTV-able format; the fallback is a solid colour so channels are
irrelevant).

Because the swapchain can change format mid-session (producer appears), rebuild
the swapchain when `srcFormat` changes (the existing size-change check in
`ensureSwapchain` at `layer.cpp:427-428` — extend it to compare format too).

### 2. Track whether a swizzle is needed

```c
bool needsSwizzle = false;  // true when src format != swapchain format and both are 8-bit UNORM
```

Set it in `my_xrEndFrame` after picking/opening the slot:

```c
const DXGI_FORMAT srcFmt = (DXGI_FORMAT)frame.format;
const DXGI_FORMAT dstFmt = (DXGI_FORMAT)g.swapchainFormat;
g.needsSwizzle = (srcFmt != dstFmt) &&
                 (srcFmt == DXGI_FORMAT_B8G8R8A8_UNORM ||
                  srcFmt == DXGI_FORMAT_R8G8B8A8_UNORM) &&
                 (dstFmt == DXGI_FORMAT_B8G8R8A8_UNORM ||
                  dstFmt == DXGI_FORMAT_R8G8B8A8_UNORM);
```

### 3. Swizzle in the pixel shader

Add a second PS, or a branch on a shader constant. Cheapest is a second shader
compiled once at startup:

```hlsl
// kPS (no swizzle) — unchanged
// kPSSwizzle:
Texture2D tex:register(t0);SamplerState smp:register(s0);
float4 main(float4 pos:SV_Position,float2 uv:TEXCOORD0):SV_Target{
  float4 c = tex.Sample(smp,uv);
  return float4(c.b, c.g, c.r, c.a);  // BGRA<->RGBA
}
```

Compile both in `createBlitPipeline` (`layer.cpp:265-308`), store `g.ps` and
`g.psSwizzle`. In the blit, select:

```c
dc->PSSetShader(g.needsSwizzle ? g.psSwizzle : g.ps, nullptr, 0);
```

### 4. Force a canonical format on the producer (optional, simpler)

Alternative to swizzle: make the producer always create its shared texture as
`DXGI_FORMAT_B8G8R8A8_UNORM` and `CopySubresourceRegion`-convert if the source
is RGBA. D3D11 will convert 8-bit UNORM BGRA<->RGBA on copy automatically. Then
the consumer only ever sees BGRA and `pickFormat(BGRA)` handles it. This puts
the (cheap) conversion on the producer GPU and keeps the consumer shader
trivial. Pick **one** strategy; the swizzle approach avoids an extra format
conversion in the producer.

### 5. Validate the source format on first frame

The producer already logs the shared-texture format (`vr_overlay.cc:335`).
Also log it in the consumer when a slot is first opened
(`layer.cpp:378-379`), including `srcFmt` vs `dstFmt` and `needsSwizzle`, so a
mismatch is obvious in `irdashies-openxr-layer.log`.

## Code touch points

| File | Change |
| --- | --- |
| `native/openxr-layer/src/layer.cpp` | `pickFormat(srcFmt)`, swizzle flag, second PS, swapchain rebuild on format change, logging. |
| `src/app/vr/native/vr_overlay.cc` | (Only if strategy 4 chosen) force BGRA shared texture. |
| `native/shm-test-producer/src/producer.cpp` | Already BGRA8 — good reference; add a RGBA variant to test the swizzle path. |

## References

- DXGI format list & compatibility:
  https://learn.microsoft.com/en-us/windows/win32/api/dxgiformat/ne-dxgiformat-dxgi_format
- D3D11 auto-conversion on `CopySubresourceRegion` (typeless/UNORM 8-bit):
  https://learn.microsoft.com/en-us/windows/win32/direct3d11/overviews-direct3d-11-resources-types
- OpenKneeboard fixes BGRA in `SHM.hpp:50-52` (cited in
  `vr-website-rendering.md:36`) — same fixed-format contract.

## How to test

1. **Probe pixel test (no headset)** — extend `irdashies-shm-probe` to sample
   known pixels and assert channel values:
   - Producer renders a solid **red** square (`R=255,G=0,B=0`) and a solid
     **blue** square (`B=255`).
   - Probe reads them back and asserts `R` channel is high in the red square
     and `B` channel is high in the blue square.
   - Run with both a BGRA and an RGBA producer variant; both must PASS.
2. **Swapchain format matrix (no headset, layer logic)** — unit-test
   `pickFormat` + `needsSwizzle` by feeding a fake supported-format list and
   every `srcFmt`, asserting the resulting `(dstFmt, needsSwizzle)` pair
   preserves channel identity. (This requires pulling the function into a
   testable translation unit / splitting it out.)
3. **In-headset** — render a widget with a known red/blue element (e.g. a
   flag icon). Confirm red is red and blue is blue, not swapped. Toggle the
   runtime's preferred swapchain format if possible (or force it by reordering
   `pickFormat`'s fallback list) and re-confirm.
4. **Log inspection** — `irdashies-openxr-layer.log` should print
   `srcFmt=BGRA dstFmt=BGRA swizzle=0` (or the RGBA variant with `swizzle=1`),
   never `srcFmt=BGRA dstFmt=RGBA swizzle=0`.
