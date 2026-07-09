// irDashies OpenXR shared-memory contract.
//
// This header is the SINGLE source of truth shared by:
//   - the producer (app side: writes the texture + metadata)
//   - the consumer (OpenXR API layer: reads + composites into the headset)
//
// Both binaries MUST be built from the same version of this header. The
// mapping/mutex names are versioned; bump IRDASHIES_SHM_VERSION (and the
// names) on any incompatible layout change so an old consumer never
// misreads a new producer's bytes.
//
// v2: triple-buffer ring + reserved per-layer table (#04).

#pragma once

#include <cstdint>

#define IRDASHIES_SHM_MAPPING_NAME L"Local\\irdashies-openxr-shm-v2"
#define IRDASHIES_SHM_MUTEX_NAME L"Local\\irdashies-openxr-shm-v2.mutex"

#define IRDASHIES_SHM_MAGIC 0x32445249u  // 'IRD2'
#define IRDASHIES_SHM_VERSION 2u

#define IRDASHIES_SHM_RING_SIZE 3u
#define IRDASHIES_SHM_MAX_LAYERS 16u

// flags
#define IRDASHIES_SHM_FLAG_FEEDER_ATTACHED 0x1u

#pragma pack(push, 8)

struct IrdashiesShmFrameSlot {
  uint64_t textureHandle;  // NT handle to this slot's shared D3D11 texture
  uint32_t width;
  uint32_t height;
  uint32_t format;         // DXGI_FORMAT
  uint64_t frameNumber;    // monotonic; 0 = slot never written
};

struct IrdashiesShmLayer {
  float posePosition[3];       // metres, LOCAL space
  float poseOrientation[4];    // quaternion x,y,z,w
  float quadSizeMeters[2];     // width, height
  float sourceRect[4];         // x, y, w, h in atlas texels
  float opacity;               // 0..1
  uint32_t visible;            // 0 = skip this layer
};

struct IrdashiesShmHeader {
  uint32_t magic;              // IRDASHIES_SHM_MAGIC once initialised
  uint32_t version;            // IRDASHIES_SHM_VERSION
  uint32_t feederProcessId;    // producer PID
  uint32_t flags;              // IRDASHIES_SHM_FLAG_*
  int64_t  adapterLuid;        // producer GPU LUID; consumer must match adapter

  uint64_t fenceHandle;        // NT handle to shared D3D11 fence (single, producer PID)
  uint64_t fenceValue;         // latest signalled value (matches frames[latestIndex])

  uint32_t writeIndex;         // producer's NEXT slot to write (0..RING_SIZE-1)
  uint32_t latestIndex;        // slot index of most recent COMPLETED frame
  uint32_t ringSize;           // == IRDASHIES_SHM_RING_SIZE (consumer sanity check)

  IrdashiesShmFrameSlot frames[IRDASHIES_SHM_RING_SIZE];

  uint32_t recenterCounter;    // bumped to request consumer recenter

  // Shared pose for MVP; per-layer pose arrives in layers[] (#04).
  float posePosition[3];       // metres
  float poseOrientation[4];    // quaternion x,y,z,w
  float quadSizeMeters[2];     // width,height in metres

  // Reserved for #04 — layer table (atlas + N per-widget quads).
  uint32_t layerCount;         // 0..MAX_LAYERS
  IrdashiesShmLayer layers[IRDASHIES_SHM_MAX_LAYERS];
};

#pragma pack(pop)
