// irDashies OpenXR API layer.
//
// Implicit API layer: injects into OpenXR D3D11 apps, hooks xrEndFrame, and
// renders a composition-layer quad into the headset.
//
// Stage 2 (this file): reads a shared D3D11 texture published by the producer
// over shared memory (see ../../shared/irdashies_shm.h), opens it on the game's
// device, waits on the shared fence, and shader-blits it onto the quad. If no
// producer is running it falls back to an animated solid color so there is
// always visible feedback.

#define XR_USE_GRAPHICS_API_D3D11
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <d3d11_4.h>
#include <d3dcompiler.h>

#include <openxr/openxr.h>
#include <openxr/openxr_platform.h>
// Loader<->API-layer negotiation types. Note: pre-1.0.33 SDKs called this
// header <openxr/loader_interfaces.h>; it was renamed in 1.0.33.
#include <openxr/openxr_loader_negotiation.h>

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string_view>
#include <vector>

#include "irdashies_shm.h"

// ---------------------------------------------------------------------------
// Process gate: only inject into iRacing
// ---------------------------------------------------------------------------
static bool g_gatedOff = false;  // true = not iRacing, do nothing

static bool hostIsIRacing() {
  wchar_t path[MAX_PATH];
  DWORD n = GetModuleFileNameW(nullptr, path, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return false;
  wchar_t* base = path;
  for (wchar_t* p = path; *p; ++p) if (*p == L'\\' || *p == L'/') base = p + 1;
  return _wcsicmp(base, L"iRacingSim64DX11.exe") == 0;
}

// ---------------------------------------------------------------------------
// Logging (no debugger in an injected game process; log to a temp file)
// ---------------------------------------------------------------------------
static void layerLog(const char* fmt, ...) {
  char buf[1024];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);

  OutputDebugStringA("[irDashies-OpenXR] ");
  OutputDebugStringA(buf);
  OutputDebugStringA("\n");

  char path[MAX_PATH];
  if (GetTempPathA(MAX_PATH, path)) {
    strncat_s(path, MAX_PATH, "irdashies-openxr-layer.log", _TRUNCATE);
    FILE* f = nullptr;
    if (fopen_s(&f, path, "a") == 0 && f) {
      fprintf(f, "%s\n", buf);
      fclose(f);
    }
  }
}

template <typename T>
static void release(T*& p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

// ---------------------------------------------------------------------------
// Next-in-chain dispatch table
// ---------------------------------------------------------------------------
static PFN_xrGetInstanceProcAddr g_nextGetInstanceProcAddr = nullptr;

static PFN_xrCreateSession g_next_xrCreateSession = nullptr;
static PFN_xrDestroySession g_next_xrDestroySession = nullptr;
static PFN_xrEndFrame g_next_xrEndFrame = nullptr;
static PFN_xrEnumerateSwapchainFormats g_next_xrEnumerateSwapchainFormats = nullptr;
static PFN_xrCreateSwapchain g_next_xrCreateSwapchain = nullptr;
static PFN_xrDestroySwapchain g_next_xrDestroySwapchain = nullptr;
static PFN_xrEnumerateSwapchainImages g_next_xrEnumerateSwapchainImages = nullptr;
static PFN_xrAcquireSwapchainImage g_next_xrAcquireSwapchainImage = nullptr;
static PFN_xrWaitSwapchainImage g_next_xrWaitSwapchainImage = nullptr;
static PFN_xrReleaseSwapchainImage g_next_xrReleaseSwapchainImage = nullptr;
static PFN_xrCreateReferenceSpace g_next_xrCreateReferenceSpace = nullptr;
static PFN_xrDestroySpace g_next_xrDestroySpace = nullptr;
static PFN_xrLocateSpace g_next_xrLocateSpace = nullptr;

// ---------------------------------------------------------------------------
// Shared-memory reader (producer -> consumer transport)
// ---------------------------------------------------------------------------
static HANDLE g_shmMapping = nullptr;
static HANDLE g_shmMutex = nullptr;
static const IrdashiesShmHeader* g_shm = nullptr;

static bool ensureShmOpen() {
  if (g_shm) return true;
  if (!g_shmMapping) {
    g_shmMapping =
        OpenFileMappingW(FILE_MAP_READ, FALSE, IRDASHIES_SHM_MAPPING_NAME);
    if (!g_shmMapping) return false;  // producer not running
  }
  if (!g_shmMutex) {
    g_shmMutex = OpenMutexW(SYNCHRONIZE, FALSE, IRDASHIES_SHM_MUTEX_NAME);
  }
  g_shm = (const IrdashiesShmHeader*)MapViewOfFile(
      g_shmMapping, FILE_MAP_READ, 0, 0, sizeof(IrdashiesShmHeader));
  if (g_shm) layerLog("Connected to producer shared memory.");
  return g_shm != nullptr;
}

static bool readShmFrame(IrdashiesShmHeader& out) {
  if (!ensureShmOpen()) return false;
  bool locked = false;
  if (g_shmMutex) {
    locked = (WaitForSingleObject(g_shmMutex, 8) == WAIT_OBJECT_0);
  }
  memcpy(&out, g_shm, sizeof(out));
  if (locked) ReleaseMutex(g_shmMutex);

  if (out.magic != IRDASHIES_SHM_MAGIC || out.version != IRDASHIES_SHM_VERSION) {
    return false;
  }
  if (!(out.flags & IRDASHIES_SHM_FLAG_FEEDER_ATTACHED)) return false;
  if (out.latestIndex >= IRDASHIES_SHM_RING_SIZE) return false;
  if (out.frames[out.latestIndex].frameNumber == 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------
static constexpr uint32_t kFallbackSize = 512;

struct SlotView {
  uint64_t texHandleVal = 0;  // handle value this view was opened from
  ID3D11Texture2D* texture = nullptr;
  ID3D11ShaderResourceView* srv = nullptr;
};

struct SessionState {
  XrSession session = XR_NULL_HANDLE;
  ID3D11Device* device = nullptr;
  ID3D11Device1* device1 = nullptr;
  ID3D11Device5* device5 = nullptr;
  ID3D11DeviceContext* context = nullptr;
  ID3D11DeviceContext4* context4 = nullptr;
  // Deferred context for our blit so we never mutate the game's immediate
  // context pipeline state (which would corrupt the game's own rendering).
  ID3D11DeviceContext* deferred = nullptr;
  int64_t adapterLuid = 0;  // game GPU; must match the producer's
  XrSpace localSpace = XR_NULL_HANDLE;
  XrSpace stageSpace = XR_NULL_HANDLE;
  XrSpace viewSpace = XR_NULL_HANDLE;

  // Recenter: when the producer's recenterCounter changes, capture the head
  // pose and pin the quad in front of it until the next recenter.
  uint32_t lastRecenterCounter = 0;
  bool hasRecenterPose = false;
  XrPosef recenterPose{};
  float recenterYaw = 0;
  float recenterEyeY = 0;

  // Quad swapchain (sized to the shared texture, or kFallbackSize).
  XrSwapchain swapchain = XR_NULL_HANDLE;
  int64_t swapchainFormat = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<ID3D11Texture2D*> images;
  std::vector<ID3D11RenderTargetView*> rtvs;

  // Fullscreen-triangle blit pipeline.
  ID3D11VertexShader* vs = nullptr;
  ID3D11PixelShader* ps = nullptr;
  ID3D11PixelShader* psSwizzle = nullptr;   // R<->B swizzle variant
  ID3D11SamplerState* sampler = nullptr;
  ID3D11RasterizerState* rasterState = nullptr;  // CULL_NONE (winding-agnostic)
  bool needsSwizzle = false;

  // Shared producer resources (cached per ring slot).
  uint32_t feederPid = 0;
  uint64_t fenceHandleVal = 0;
  ID3D11Fence* fence = nullptr;
  SlotView slotViews[IRDASHIES_SHM_RING_SIZE];
};
static SessionState g;

// Rotate vector v by quaternion q (v' = q * v * q^-1, expanded).
static XrVector3f rotateVec(const XrQuaternionf& q, const XrVector3f& v) {
  const XrVector3f t{2.0f * (q.y * v.z - q.z * v.y),
                     2.0f * (q.z * v.x - q.x * v.z),
                     2.0f * (q.x * v.y - q.y * v.x)};
  const XrVector3f c{q.y * t.z - q.z * t.y, q.z * t.x - q.x * t.z,
                     q.x * t.y - q.y * t.x};
  return {v.x + q.w * t.x + c.x, v.y + q.w * t.y + c.y, v.z + q.w * t.z + c.z};
}

static XrVector3f cross3(const XrVector3f& a, const XrVector3f& b) {
  return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}

static float len3(const XrVector3f& v) {
  return std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

static XrVector3f norm3(const XrVector3f& v) {
  const float l = len3(v);
  return l > 1e-6f ? XrVector3f{v.x / l, v.y / l, v.z / l} : v;
}

// Build a quaternion from an orthonormal basis (columns map local X,Y,Z).
static XrQuaternionf quatFromBasis(const XrVector3f& r, const XrVector3f& u,
                                   const XrVector3f& n) {
  const float m00 = r.x, m01 = u.x, m02 = n.x;
  const float m10 = r.y, m11 = u.y, m12 = n.y;
  const float m20 = r.z, m21 = u.z, m22 = n.z;
  const float tr = m00 + m11 + m22;
  XrQuaternionf q;
  if (tr > 0.0f) {
    const float s = std::sqrt(tr + 1.0f) * 2.0f;
    q.w = 0.25f * s;
    q.x = (m21 - m12) / s;
    q.y = (m02 - m20) / s;
    q.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const float s = std::sqrt(1.0f + m00 - m11 - m22) * 2.0f;
    q.w = (m21 - m12) / s;
    q.x = 0.25f * s;
    q.y = (m01 + m10) / s;
    q.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const float s = std::sqrt(1.0f + m11 - m00 - m22) * 2.0f;
    q.w = (m02 - m20) / s;
    q.x = (m01 + m10) / s;
    q.y = 0.25f * s;
    q.z = (m12 + m21) / s;
  } else {
    const float s = std::sqrt(1.0f + m22 - m00 - m11) * 2.0f;
    q.w = (m10 - m01) / s;
    q.x = (m02 + m20) / s;
    q.y = (m12 + m21) / s;
    q.z = 0.25f * s;
  }
  return q;
}

// Hamilton product a*b. rotateVec(a*b, v) == rotateVec(a, rotateVec(b, v)), so
// this composes b (local) inside a (parent): world = parent * local.
static XrQuaternionf quatMul(const XrQuaternionf& a, const XrQuaternionf& b) {
  return {a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
          a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
          a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
          a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z};
}

// ---------------------------------------------------------------------------
// Blit shaders
// ---------------------------------------------------------------------------
static const char kVS[] =
    "struct VSOut{float4 pos:SV_Position;float2 uv:TEXCOORD0;};"
    "VSOut main(uint id:SV_VertexID){"
    "  VSOut o;"
    "  float2 uv=float2((id<<1)&2,id&2);"
    "  o.uv=uv;"
    "  o.pos=float4(uv*float2(2,-2)+float2(-1,1),0,1);"
    "  return o;"
    "}";

static const char kPS[] =
    "Texture2D tex:register(t0);SamplerState smp:register(s0);"
    "float4 main(float4 pos:SV_Position,float2 uv:TEXCOORD0):SV_Target{"
    "  return tex.Sample(smp,uv);"
    "}";

static const char kPSSwizzle[] =
    "Texture2D tex:register(t0);SamplerState smp:register(s0);"
    "float4 main(float4 pos:SV_Position,float2 uv:TEXCOORD0):SV_Target{"
    "  float4 c=tex.Sample(smp,uv);"
    "  return float4(c.b,c.g,c.r,c.a);"
    "}";

static bool createBlitPipeline() {
  ID3DBlob* vsb = nullptr;
  ID3DBlob* psb = nullptr;
  ID3DBlob* err = nullptr;
  if (FAILED(D3DCompile(kVS, sizeof(kVS) - 1, "vs", nullptr, nullptr, "main",
                        "vs_5_0", 0, 0, &vsb, &err))) {
    layerLog("VS compile failed: %s", err ? (char*)err->GetBufferPointer() : "");
    release(err);
    return false;
  }
  if (FAILED(D3DCompile(kPS, sizeof(kPS) - 1, "ps", nullptr, nullptr, "main",
                        "ps_5_0", 0, 0, &psb, &err))) {
    layerLog("PS compile failed: %s", err ? (char*)err->GetBufferPointer() : "");
    release(err);
    release(vsb);
    return false;
  }
  HRESULT a = g.device->CreateVertexShader(vsb->GetBufferPointer(),
                                           vsb->GetBufferSize(), nullptr, &g.vs);
  HRESULT b = g.device->CreatePixelShader(psb->GetBufferPointer(),
                                          psb->GetBufferSize(), nullptr, &g.ps);
  release(vsb);
  release(psb);

  ID3DBlob* swizzlePsb = nullptr;
  if (SUCCEEDED(D3DCompile(kPSSwizzle, sizeof(kPSSwizzle) - 1,
                           "ps_swizzle", nullptr, nullptr, "main",
                           "ps_5_0", 0, 0, &swizzlePsb, nullptr))) {
    g.device->CreatePixelShader(swizzlePsb->GetBufferPointer(),
                                swizzlePsb->GetBufferSize(), nullptr,
                                &g.psSwizzle);
    release(swizzlePsb);
  }

  if (FAILED(a) || FAILED(b)) {
    layerLog("Create shader failed.");
    return false;
  }

  D3D11_SAMPLER_DESC sd{};
  sd.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
  sd.AddressU = sd.AddressV = sd.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
  sd.ComparisonFunc = D3D11_COMPARISON_NEVER;
  sd.MaxLOD = D3D11_FLOAT32_MAX;
  if (FAILED(g.device->CreateSamplerState(&sd, &g.sampler))) return false;

  // CULL_NONE so the fullscreen triangle is drawn regardless of winding/front
  // face. Our shader flips Y for correct texture orientation, which would make
  // the triangle back-facing under the default rasterizer state.
  D3D11_RASTERIZER_DESC rd{};
  rd.FillMode = D3D11_FILL_SOLID;
  rd.CullMode = D3D11_CULL_NONE;
  rd.DepthClipEnable = TRUE;
  return SUCCEEDED(g.device->CreateRasterizerState(&rd, &g.rasterState));
}

// ---------------------------------------------------------------------------
// Shared texture / fence management
// ---------------------------------------------------------------------------
static void closeSharedResources() {
  for (auto& sv : g.slotViews) {
    release(sv.srv);
    release(sv.texture);
    sv.texHandleVal = 0;
  }
  release(g.fence);
  g.feederPid = 0;
  g.fenceHandleVal = 0;
}

// Ensures the shared fence is open (once) and the per-slot texture/SRV are
// open for the given ring slot. Returns true if resources are ready to use.
static bool ensureSlotResources(const IrdashiesShmHeader& f, uint32_t slotIdx) {
  if (slotIdx >= IRDASHIES_SHM_RING_SIZE) return false;

  const auto& slot = f.frames[slotIdx];
  SlotView& sv = g.slotViews[slotIdx];

  // Check if this slot's texture is already open and still valid.
  const bool slotOk = sv.texture && g.feederPid == f.feederProcessId &&
                      sv.texHandleVal == slot.textureHandle;
  const bool fenceOk = g.fence && g.fenceHandleVal == f.fenceHandle;

  if (slotOk && fenceOk) return true;

  // Cross-adapter sharing is not possible.
  if (g.adapterLuid != 0 && f.adapterLuid != g.adapterLuid) {
    static bool logged = false;
    if (!logged) {
      logged = true;
      layerLog(
          "GPU mismatch: producer LUID 0x%llx != game LUID 0x%llx. The "
          "producer must render on the same adapter as the game.",
          (unsigned long long)f.adapterLuid,
          (unsigned long long)g.adapterLuid);
    }
    return false;
  }

  HANDLE feeder = OpenProcess(PROCESS_DUP_HANDLE, FALSE, f.feederProcessId);
  if (!feeder) {
    layerLog(
        "OpenProcess(feeder %u) failed: %lu (elevation mismatch? run irdashies "
        "and the game at the same privilege level)",
        f.feederProcessId, GetLastError());
    return false;
  }

  // Open the fence once (shared across all slots).
  if (!fenceOk) {
    release(g.fence);
    HANDLE dupFence = nullptr;
    DuplicateHandle(feeder, (HANDLE)(uintptr_t)f.fenceHandle, GetCurrentProcess(),
                    &dupFence, 0, FALSE, DUPLICATE_SAME_ACCESS);
    if (dupFence && g.device5) {
      if (SUCCEEDED(g.device5->OpenSharedFence(dupFence, IID_PPV_ARGS(&g.fence)))) {
        g.fenceHandleVal = f.fenceHandle;
      }
    }
    if (dupFence) CloseHandle(dupFence);
    if (!g.fence) {
      static bool loggedFence = false;
      if (!loggedFence) {
        loggedFence = true;
        layerLog("Failed to open shared fence.");
      }
      CloseHandle(feeder);
      return false;
    }
  }

  // Open this slot's texture if needed.
  if (!slotOk) {
    release(sv.srv);
    release(sv.texture);
    sv.texHandleVal = 0;

    HANDLE dupTex = nullptr;
    DuplicateHandle(feeder, (HANDLE)(uintptr_t)slot.textureHandle,
                    GetCurrentProcess(), &dupTex, 0, FALSE, DUPLICATE_SAME_ACCESS);

    if (dupTex && g.device1) {
      if (SUCCEEDED(g.device1->OpenSharedResource1(
              dupTex, IID_PPV_ARGS(&sv.texture))) &&
          SUCCEEDED(g.device->CreateShaderResourceView(
              sv.texture, nullptr, &sv.srv))) {
        sv.texHandleVal = slot.textureHandle;
        g.feederPid = f.feederProcessId;
        layerLog("Opened shared texture slot %u: %ux%u format %u from producer PID %u.",
                 slotIdx, slot.width, slot.height, slot.format,
                 f.feederProcessId);
      }
    }
    if (dupTex) CloseHandle(dupTex);
    if (!sv.texture) {
      static bool loggedTex = false;
      if (!loggedTex) {
        loggedTex = true;
        layerLog("Failed to open shared texture slot %u.", slotIdx);
      }
    }
  }

  CloseHandle(feeder);
  return sv.texture && g.fence;
}

// ---------------------------------------------------------------------------
// Swapchain management (recreated when target size/format changes)
// ---------------------------------------------------------------------------
static int64_t pickFormat(DXGI_FORMAT srcFormat = DXGI_FORMAT_UNKNOWN) {
  uint32_t count = 0;
  g_next_xrEnumerateSwapchainFormats(g.session, 0, &count, nullptr);
  std::vector<int64_t> formats(count);
  g_next_xrEnumerateSwapchainFormats(g.session, count, &count, formats.data());
  // 1) exact match with the producer's source format (no swizzle needed)
  for (int64_t f : formats) if (f == (int64_t)srcFormat) return f;
  // 2) the other common UNORM 8-bit format (swizzle in shader if mismatch)
  for (int64_t want : {(int64_t)DXGI_FORMAT_B8G8R8A8_UNORM,
                       (int64_t)DXGI_FORMAT_R8G8B8A8_UNORM}) {
    for (int64_t f : formats) {
      if (f == want) return f;
    }
  }
  return formats.empty() ? (int64_t)DXGI_FORMAT_R8G8B8A8_UNORM : formats.front();
}

static void destroySwapchain() {
  for (auto* rtv : g.rtvs) release(rtv);
  g.rtvs.clear();
  g.images.clear();  // OpenXR owns the image textures; do not Release them
  if (g.swapchain) {
    g_next_xrDestroySwapchain(g.swapchain);
    g.swapchain = XR_NULL_HANDLE;
  }
  g.width = g.height = 0;
}

static bool ensureSwapchain(uint32_t w, uint32_t h, int64_t format) {
  if (g.swapchain && g.width == w && g.height == h &&
      g.swapchainFormat == format) return true;
  destroySwapchain();

  g.swapchainFormat = format;

  XrSwapchainCreateInfo sc{XR_TYPE_SWAPCHAIN_CREATE_INFO};
  sc.usageFlags = XR_SWAPCHAIN_USAGE_COLOR_ATTACHMENT_BIT;
  sc.format = g.swapchainFormat;
  sc.sampleCount = 1;
  sc.width = w;
  sc.height = h;
  sc.faceCount = 1;
  sc.arraySize = 1;
  sc.mipCount = 1;
  if (XR_FAILED(g_next_xrCreateSwapchain(g.session, &sc, &g.swapchain))) {
    layerLog("xrCreateSwapchain failed.");
    g.swapchain = XR_NULL_HANDLE;
    return false;
  }

  uint32_t imageCount = 0;
  g_next_xrEnumerateSwapchainImages(g.swapchain, 0, &imageCount, nullptr);
  std::vector<XrSwapchainImageD3D11KHR> imgs(
      imageCount, {XR_TYPE_SWAPCHAIN_IMAGE_D3D11_KHR});
  g_next_xrEnumerateSwapchainImages(
      g.swapchain, imageCount, &imageCount,
      reinterpret_cast<XrSwapchainImageBaseHeader*>(imgs.data()));

  for (auto& im : imgs) {
    g.images.push_back(im.texture);
    D3D11_RENDER_TARGET_VIEW_DESC rtvDesc{};
    rtvDesc.Format = (DXGI_FORMAT)g.swapchainFormat;
    rtvDesc.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
    ID3D11RenderTargetView* rtv = nullptr;
    g.device->CreateRenderTargetView(im.texture, &rtvDesc, &rtv);
    g.rtvs.push_back(rtv);
  }
  g.width = w;
  g.height = h;
  return true;
}

// ---------------------------------------------------------------------------
// xrEndFrame
// ---------------------------------------------------------------------------
static XrResult XRAPI_CALL my_xrEndFrame(XrSession session,
                                         const XrFrameEndInfo* frameEndInfo) {
  if (g_gatedOff) return g_next_xrEndFrame(session, frameEndInfo);
  if (session != g.session || !g.device) {
    return g_next_xrEndFrame(session, frameEndInfo);
  }

  IrdashiesShmHeader frame{};
  bool haveFrame = readShmFrame(frame);
  uint32_t slotIdx = 0;
  if (haveFrame) {
    slotIdx = frame.latestIndex;
    haveFrame = ensureSlotResources(frame, slotIdx);
  }

  // Recenter request: pin the quad in front of the current head pose.
  // Like OpenKneeboard: anchor X/Z and yaw update every recenter; Y is
  // captured separately and zeroed in the anchor so head tilt (looking
  // up/down) doesn't drift the quad vertically.
  if (haveFrame && frame.recenterCounter != g.lastRecenterCounter) {
    g.lastRecenterCounter = frame.recenterCounter;
    XrSpaceLocation loc{XR_TYPE_SPACE_LOCATION};
    if (g.viewSpace && g.localSpace &&
        XR_SUCCEEDED(g_next_xrLocateSpace(g.viewSpace, g.localSpace,
                                          frameEndInfo->displayTime, &loc)) &&
        (loc.locationFlags & XR_SPACE_LOCATION_POSITION_VALID_BIT)) {
      // Yaw-only from head orientation (gravity-aligned, like OpenKneeboard).
      const XrVector3f facing = rotateVec(loc.pose.orientation, {0, 0, -1});
      g.recenterYaw = std::atan2(facing.x, -facing.z);

      // X/Z anchor plus eye height (Y zeroed in the anchor).
      g.recenterPose.position.x = loc.pose.position.x;
      g.recenterPose.position.z = loc.pose.position.z;
      g.recenterEyeY = loc.pose.position.y;
      g.hasRecenterPose = true;
      layerLog("Recentered quad anchor.");
    }
  }

  const auto& slot = haveFrame ? frame.frames[slotIdx] : frame.frames[0];
  const uint32_t w = haveFrame ? slot.width : kFallbackSize;
  const uint32_t h = haveFrame ? slot.height : kFallbackSize;

  int64_t fmt = g.swapchainFormat;
  if (haveFrame) {
    const DXGI_FORMAT srcFmt = (DXGI_FORMAT)slot.format;
    fmt = pickFormat(srcFmt);
    const DXGI_FORMAT dstFmt = (DXGI_FORMAT)fmt;
    g.needsSwizzle = (srcFmt != dstFmt) &&
                     (srcFmt == DXGI_FORMAT_B8G8R8A8_UNORM ||
                      srcFmt == DXGI_FORMAT_R8G8B8A8_UNORM) &&
                     (dstFmt == DXGI_FORMAT_B8G8R8A8_UNORM ||
                      dstFmt == DXGI_FORMAT_R8G8B8A8_UNORM);
  }
  if (fmt == 0) fmt = pickFormat();

  if (!haveFrame) return g_next_xrEndFrame(session, frameEndInfo);

  if (!ensureSwapchain(w, h, fmt)) {
    return g_next_xrEndFrame(session, frameEndInfo);
  }

  uint32_t idx = 0;
  XrSwapchainImageAcquireInfo acq{XR_TYPE_SWAPCHAIN_IMAGE_ACQUIRE_INFO};
  if (XR_FAILED(g_next_xrAcquireSwapchainImage(g.swapchain, &acq, &idx))) {
    return g_next_xrEndFrame(session, frameEndInfo);
  }
  XrSwapchainImageWaitInfo wait{XR_TYPE_SWAPCHAIN_IMAGE_WAIT_INFO};
  wait.timeout = XR_INFINITE_DURATION;
  g_next_xrWaitSwapchainImage(g.swapchain, &wait);

  // Wait on the GPU until the producer signalled this frame is ready.
  g.context4->Wait(g.fence, frame.fenceValue);

  // Record the blit on the deferred context (default pipeline state) and
  // execute with RestoreContextState=TRUE so the game's immediate context
  // state is preserved. Falling back to the immediate context only if no
  // deferred context is available.
  ID3D11DeviceContext* dc = g.deferred ? g.deferred : g.context;
  dc->OMSetRenderTargets(1, &g.rtvs[idx], nullptr);
  D3D11_VIEWPORT vp{0, 0, (float)w, (float)h, 0, 1};
  dc->RSSetViewports(1, &vp);
  dc->RSSetState(g.rasterState);
  dc->IASetInputLayout(nullptr);
  dc->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
  dc->VSSetShader(g.vs, nullptr, 0);
  dc->PSSetShader(g.needsSwizzle && g.psSwizzle ? g.psSwizzle : g.ps, nullptr, 0);
  dc->PSSetShaderResources(0, 1, &g.slotViews[slotIdx].srv);
  dc->PSSetSamplers(0, 1, &g.sampler);
  dc->Draw(3, 0);

  ID3D11ShaderResourceView* nullSrv = nullptr;
  dc->PSSetShaderResources(0, 1, &nullSrv);  // clear hazard

  if (g.deferred) {
    ID3D11CommandList* cmd = nullptr;
    if (SUCCEEDED(g.deferred->FinishCommandList(FALSE, &cmd)) && cmd) {
      g.context->ExecuteCommandList(cmd, TRUE);
      cmd->Release();
    }
  }

  XrSwapchainImageReleaseInfo rel{XR_TYPE_SWAPCHAIN_IMAGE_RELEASE_INFO};
  g_next_xrReleaseSwapchainImage(g.swapchain, &rel);

  // Build per-widget quads from the layer table. Each quad references the
  // same swapchain but with a different subImage.imageRect (the widget's
  // sub-rect in the atlas), its own pose, size, and opacity.
  std::vector<XrCompositionLayerQuad> ourQuads;
  const uint32_t lc = frame.layerCount;
  if (lc > 0 && lc <= IRDASHIES_SHM_MAX_LAYERS) {
    for (uint32_t i = 0; i < lc; ++i) {
      const auto& layer = frame.layers[i];
      if (!layer.visible) continue;
      XrCompositionLayerQuad q{XR_TYPE_COMPOSITION_LAYER_QUAD};
      q.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
      q.space = g.localSpace;
      q.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
      q.subImage.swapchain = g.swapchain;
      // Clamp sourceRect to the swapchain extent so a mismatched OSR window
      // size never samples beyond the swapchain bounds.
      q.subImage.imageRect.offset.x = (int32_t)layer.sourceRect[0];
      q.subImage.imageRect.offset.y = (int32_t)layer.sourceRect[1];
      q.subImage.imageRect.extent.width =
          (int32_t)std::min(layer.sourceRect[2], (float)w);
      q.subImage.imageRect.extent.height =
          (int32_t)std::min(layer.sourceRect[3], (float)h);
      q.subImage.imageArrayIndex = 0;
      if (g.hasRecenterPose) {
        const float h = layer.posePosition[0];
        const float v = layer.posePosition[1];
        const float d = -layer.posePosition[2];
        const float cy = std::cos(g.recenterYaw);
        const float sy = std::sin(g.recenterYaw);
        const float halfYaw = g.recenterYaw * 0.5f;
        q.pose.orientation = {0.0f, std::sin(-halfYaw), 0.0f, std::cos(-halfYaw)};
        q.pose.position = {
            g.recenterPose.position.x + h * cy + d * sy,
            g.recenterEyeY + v,
            g.recenterPose.position.z + h * sy - d * cy,
        };
      } else {
        q.pose.position = {layer.posePosition[0], layer.posePosition[1],
                           layer.posePosition[2]};
        q.pose.orientation = {layer.poseOrientation[0], layer.poseOrientation[1],
                              layer.poseOrientation[2], layer.poseOrientation[3]};
      }
      q.size = {layer.quadSizeMeters[0], layer.quadSizeMeters[1]};
      ourQuads.push_back(q);
    }
  }

  // Fallback: no layer table → single quad from shared pose fields.
  if (ourQuads.empty()) {
  XrCompositionLayerQuad q{XR_TYPE_COMPOSITION_LAYER_QUAD};
  q.layerFlags = XR_COMPOSITION_LAYER_BLEND_TEXTURE_SOURCE_ALPHA_BIT;
  q.space = g.localSpace;
  q.eyeVisibility = XR_EYE_VISIBILITY_BOTH;
  q.subImage.swapchain = g.swapchain;
  q.subImage.imageRect = {{0, 0}, {(int32_t)w, (int32_t)h}};
  q.subImage.imageArrayIndex = 0;
  const float hp = frame.posePosition[0];
  const float vert = frame.posePosition[1];
  const float dp = -frame.posePosition[2];
  if (g.hasRecenterPose) {
    const float cy = std::cos(g.recenterYaw);
    const float sy = std::sin(g.recenterYaw);
    const float halfYaw = g.recenterYaw * 0.5f;
    q.pose.orientation = {0.0f, std::sin(-halfYaw), 0.0f, std::cos(-halfYaw)};
    q.pose.position = {
        g.recenterPose.position.x + hp * cy + dp * sy,
        g.recenterEyeY + vert,
        g.recenterPose.position.z + hp * sy - dp * cy,
    };
  } else {
    q.pose.orientation = {0, 0, 0, 1};
    q.pose.position = {hp, vert, -dp};
  }
  q.size = {frame.quadSizeMeters[0], frame.quadSizeMeters[1]};
  ourQuads.push_back(q);
  }

  std::vector<const XrCompositionLayerBaseHeader*> layers(
      frameEndInfo->layers, frameEndInfo->layers + frameEndInfo->layerCount);
  for (auto& q : ourQuads) {
    layers.push_back(reinterpret_cast<const XrCompositionLayerBaseHeader*>(&q));
  }

  XrFrameEndInfo patched = *frameEndInfo;
  patched.layerCount = (uint32_t)layers.size();
  patched.layers = layers.data();
  return g_next_xrEndFrame(session, &patched);
}

// ---------------------------------------------------------------------------
// xrCreateSession / xrDestroySession
// ---------------------------------------------------------------------------
static XrResult XRAPI_CALL my_xrCreateSession(
    XrInstance instance, const XrSessionCreateInfo* createInfo,
    XrSession* session) {
  if (g_gatedOff) return g_next_xrCreateSession(instance, createInfo, session);
  XrResult res = g_next_xrCreateSession(instance, createInfo, session);
  if (XR_FAILED(res)) return res;

  const XrBaseInStructure* base =
      reinterpret_cast<const XrBaseInStructure*>(createInfo->next);
  const XrGraphicsBindingD3D11KHR* d3d = nullptr;
  while (base) {
    if (base->type == XR_TYPE_GRAPHICS_BINDING_D3D11_KHR) {
      d3d = reinterpret_cast<const XrGraphicsBindingD3D11KHR*>(base);
      break;
    }
    base = base->next;
  }
  if (!d3d || !d3d->device) {
    layerLog("Session created but no D3D11 binding - overlay disabled.");
    return res;
  }

  g = SessionState{};
  g.session = *session;
  g.device = d3d->device;
  g.device->QueryInterface(IID_PPV_ARGS(&g.device1));
  g.device->QueryInterface(IID_PPV_ARGS(&g.device5));
  g.device->GetImmediateContext(&g.context);
  g.context->QueryInterface(IID_PPV_ARGS(&g.context4));
  if (!g.device1 || !g.device5 || !g.context4) {
    layerLog("Required D3D11.1/11.4 interfaces unavailable - overlay disabled.");
    g = SessionState{};
    return res;
  }

  // Deferred context so our blit never disturbs the game's immediate context.
  g.device->CreateDeferredContext(0, &g.deferred);
  if (!g.deferred) {
    layerLog(
        "CreateDeferredContext failed - using immediate context (may disturb "
        "game render state).");
  }

  // Record the game's GPU LUID so we can detect a producer/game GPU mismatch.
  {
    IDXGIDevice* dxgiDevice = nullptr;
    IDXGIAdapter* adapter = nullptr;
    if (SUCCEEDED(g.device->QueryInterface(IID_PPV_ARGS(&dxgiDevice))) &&
        SUCCEEDED(dxgiDevice->GetAdapter(&adapter))) {
      DXGI_ADAPTER_DESC desc{};
      adapter->GetDesc(&desc);
      g.adapterLuid = (int64_t)((uint64_t)desc.AdapterLuid.HighPart << 32 |
                                (uint32_t)desc.AdapterLuid.LowPart);
    }
    release(adapter);
    release(dxgiDevice);
  }

  XrReferenceSpaceCreateInfo spaceInfo{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};
  spaceInfo.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_LOCAL;
  spaceInfo.poseInReferenceSpace.orientation = {0, 0, 0, 1};
  if (XR_FAILED(g_next_xrCreateReferenceSpace(*session, &spaceInfo,
                                              &g.localSpace))) {
    layerLog("Failed to create LOCAL reference space.");
    g = SessionState{};
    return res;
  }

  // VIEW space - used to read the head pose for recentering.
  XrReferenceSpaceCreateInfo viewSpaceInfo{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};
  viewSpaceInfo.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_VIEW;
  viewSpaceInfo.poseInReferenceSpace.orientation = {0, 0, 0, 1};
  if (XR_FAILED(g_next_xrCreateReferenceSpace(*session, &viewSpaceInfo,
                                              &g.viewSpace))) {
    layerLog("Failed to create VIEW reference space (recenter disabled).");
    g.viewSpace = XR_NULL_HANDLE;
  }

  // STAGE space - used for quad positioning so it moves with iRacing's recenter.
  XrReferenceSpaceCreateInfo stageInfo{XR_TYPE_REFERENCE_SPACE_CREATE_INFO};
  stageInfo.referenceSpaceType = XR_REFERENCE_SPACE_TYPE_STAGE;
  stageInfo.poseInReferenceSpace.orientation = {0, 0, 0, 1};
  if (XR_FAILED(g_next_xrCreateReferenceSpace(*session, &stageInfo,
                                              &g.stageSpace))) {
    layerLog("Failed to create STAGE reference space, falling back to LOCAL.");
    g.stageSpace = XR_NULL_HANDLE;
  }

  if (!createBlitPipeline()) {
    layerLog("Failed to create blit pipeline - overlay disabled.");
    return res;
  }

  layerLog("Session ready - overlay active.");
  return res;
}

static XrResult XRAPI_CALL my_xrDestroySession(XrSession session) {
  if (session == g.session) {
    closeSharedResources();
    destroySwapchain();
    release(g.rasterState);
    release(g.sampler);
    release(g.vs);
    release(g.ps);
    release(g.psSwizzle);
    if (g.localSpace) g_next_xrDestroySpace(g.localSpace);
    if (g.viewSpace) g_next_xrDestroySpace(g.viewSpace);
    if (g.stageSpace) g_next_xrDestroySpace(g.stageSpace);
    release(g.deferred);
    release(g.context4);
    release(g.context);
    release(g.device5);
    release(g.device1);
    g = SessionState{};
  }
  return g_next_xrDestroySession(session);
}

// ---------------------------------------------------------------------------
// Proc address interception
// ---------------------------------------------------------------------------
static XrResult XRAPI_CALL my_xrGetInstanceProcAddr(
    XrInstance instance, const char* name, PFN_xrVoidFunction* function) {
  if (!g_nextGetInstanceProcAddr) return XR_ERROR_HANDLE_INVALID;
  if (g_gatedOff) return g_nextGetInstanceProcAddr(instance, name, function);

  std::string_view n{name};
  if (n == "xrCreateSession") {
    *function = reinterpret_cast<PFN_xrVoidFunction>(my_xrCreateSession);
    return XR_SUCCESS;
  }
  if (n == "xrDestroySession") {
    *function = reinterpret_cast<PFN_xrVoidFunction>(my_xrDestroySession);
    return XR_SUCCESS;
  }
  if (n == "xrEndFrame") {
    *function = reinterpret_cast<PFN_xrVoidFunction>(my_xrEndFrame);
    return XR_SUCCESS;
  }
  return g_nextGetInstanceProcAddr(instance, name, function);
}

static XrResult XRAPI_CALL my_xrCreateApiLayerInstance(
    const XrInstanceCreateInfo* info, const XrApiLayerCreateInfo* layerInfo,
    XrInstance* instance) {
  if (!layerInfo || !layerInfo->nextInfo) {
    return XR_ERROR_INITIALIZATION_FAILED;
  }

  g_nextGetInstanceProcAddr = layerInfo->nextInfo->nextGetInstanceProcAddr;

  g_gatedOff = !hostIsIRacing();
  if (g_gatedOff && GetEnvironmentVariableW(L"IRDASHIES_OPENXR_FORCE_ON", nullptr, 0) != 0) {
    g_gatedOff = false;
    layerLog("IRDASHIES_OPENXR_FORCE_ON set - layer active regardless of host");
  }
  layerLog("Host process gate: %s (gatedOff=%d)",
           g_gatedOff ? "NOT iRacing -> pass-through" : "iRacing -> active",
           (int)g_gatedOff);

  XrApiLayerCreateInfo nextLayerInfo = *layerInfo;
  nextLayerInfo.nextInfo = layerInfo->nextInfo->next;

  XrResult res = layerInfo->nextInfo->nextCreateApiLayerInstance(
      info, &nextLayerInfo, instance);
  if (XR_FAILED(res)) return res;

#define LOAD(fn)                                            \
  g_nextGetInstanceProcAddr(*instance, #fn,                 \
                            reinterpret_cast<PFN_xrVoidFunction*>(&g_next_##fn))
  LOAD(xrCreateSession);
  LOAD(xrDestroySession);
  LOAD(xrEndFrame);
  LOAD(xrEnumerateSwapchainFormats);
  LOAD(xrCreateSwapchain);
  LOAD(xrDestroySwapchain);
  LOAD(xrEnumerateSwapchainImages);
  LOAD(xrAcquireSwapchainImage);
  LOAD(xrWaitSwapchainImage);
  LOAD(xrReleaseSwapchainImage);
  LOAD(xrCreateReferenceSpace);
  LOAD(xrDestroySpace);
  LOAD(xrLocateSpace);
#undef LOAD

  layerLog("API layer instance created.");
  return res;
}

// ---------------------------------------------------------------------------
// Loader negotiation entry point (name must match the JSON manifest)
// ---------------------------------------------------------------------------
extern "C" __declspec(dllexport) XrResult XRAPI_CALL
irDashies_xrNegotiateLoaderApiLayerInterface(
    const XrNegotiateLoaderInfo* loaderInfo, const char* layerName,
    XrNegotiateApiLayerRequest* apiLayerRequest) {
  (void)layerName;
  if (!loaderInfo || !apiLayerRequest) {
    return XR_ERROR_INITIALIZATION_FAILED;
  }
  if (loaderInfo->structType != XR_LOADER_INTERFACE_STRUCT_LOADER_INFO ||
      apiLayerRequest->structType !=
          XR_LOADER_INTERFACE_STRUCT_API_LAYER_REQUEST) {
    return XR_ERROR_INITIALIZATION_FAILED;
  }

  apiLayerRequest->layerInterfaceVersion = XR_CURRENT_LOADER_API_LAYER_VERSION;
  apiLayerRequest->layerApiVersion = XR_CURRENT_API_VERSION;
  apiLayerRequest->getInstanceProcAddr = my_xrGetInstanceProcAddr;
  apiLayerRequest->createApiLayerInstance = my_xrCreateApiLayerInstance;

  layerLog("Negotiated with OpenXR loader.");
  return XR_SUCCESS;
}
