// irDashies VR overlay producer (Node native addon).
//
// Bridges Electron offscreen-rendered frames to the OpenXR layer:
//   - receives the GPU shared texture handle from a `paint` event
//     (webPreferences.offscreen.useSharedTexture = true)
//   - opens it on this process's D3D11 device (OpenSharedResource1; the NT
//     handle is local to the main process, no DuplicateHandle needed here)
//   - copies it into a stable shared texture we own, signals a shared fence
//   - publishes the handles + metadata over shared memory for the layer
//
// bgra/rgba shared textures from Chromium have no keyed mutex, so no
// AcquireSync is required. Open the source per frame, copy, release promptly.
//
// Multi-quad via SHM layer table (`setLayers`); the frontend atlas page is a
// follow-up.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <d3d11_4.h>
#include <dxgi1_2.h>

#include <napi.h>

#include <cstdarg>
#include <cstdint>
#include <cstdio>

#include "irdashies_shm.h"

namespace {

void producerLog(const char* fmt, ...) {
  char buf[512];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  OutputDebugStringA("[irDashies-VR-producer] ");
  OutputDebugStringA(buf);
  OutputDebugStringA("\n");
  char path[MAX_PATH];
  if (GetTempPathA(MAX_PATH, path)) {
    strncat_s(path, MAX_PATH, "irdashies-vr-producer.log", _TRUNCATE);
    FILE* f = nullptr;
    if (fopen_s(&f, path, "a") == 0 && f) {
      fprintf(f, "%s\n", buf);
      fclose(f);
    }
  }
}

template <typename T>
void release(T*& p) {
  if (p) {
    p->Release();
    p = nullptr;
  }
}

struct Slot {
  ID3D11Texture2D* texture = nullptr;
  HANDLE handle = nullptr;
  uint32_t width = 0;
  uint32_t height = 0;
  DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
};

struct State {
  ID3D11Device* device = nullptr;
  ID3D11Device1* device1 = nullptr;
  ID3D11Device5* device5 = nullptr;
  ID3D11DeviceContext* context = nullptr;
  ID3D11DeviceContext4* context4 = nullptr;

  Slot slots[IRDASHIES_SHM_RING_SIZE];
  uint32_t writeIndex = 0;
  uint64_t frameCounter = 0;

  IrdashiesShmLayer layers[IRDASHIES_SHM_MAX_LAYERS];
  uint32_t layerCount = 0;

  ID3D11Fence* fence = nullptr;
  HANDLE fenceHandle = nullptr;
  uint64_t fenceValue = 0;

  HANDLE mapping = nullptr;
  HANDLE mutex = nullptr;
  IrdashiesShmHeader* shm = nullptr;
};

State g;

void writePose(const Napi::Object& pose) {
  if (!g.shm) return;
  auto arr = [&](const char* key, float* out, int n, const float* def) {
    if (pose.Has(key) && pose.Get(key).IsArray()) {
      Napi::Array a = pose.Get(key).As<Napi::Array>();
      for (int i = 0; i < n; ++i) {
        out[i] = (i < (int)a.Length())
                     ? a.Get(i).As<Napi::Number>().FloatValue()
                     : def[i];
      }
    } else {
      for (int i = 0; i < n; ++i) out[i] = def[i];
    }
  };
  const float defPos[3] = {0.0f, 0.0f, -1.5f};
  const float defOri[4] = {0.0f, 0.0f, 0.0f, 1.0f};
  const float defSize[2] = {0.5f, 0.5f};
  arr("position", g.shm->posePosition, 3, defPos);
  arr("orientation", g.shm->poseOrientation, 4, defOri);
  arr("size", g.shm->quadSizeMeters, 2, defSize);
}

void teardown() {
  if (g.shm) {
    g.shm->flags &= ~IRDASHIES_SHM_FLAG_FEEDER_ATTACHED;
    UnmapViewOfFile(g.shm);
    g.shm = nullptr;
  }
  if (g.mapping) {
    CloseHandle(g.mapping);
    g.mapping = nullptr;
  }
  if (g.mutex) {
    CloseHandle(g.mutex);
    g.mutex = nullptr;
  }
  for (auto& slot : g.slots) {
    release(slot.texture);
    if (slot.handle) {
      CloseHandle(slot.handle);
      slot.handle = nullptr;
    }
    slot.width = slot.height = 0;
    slot.format = DXGI_FORMAT_UNKNOWN;
  }
  g.writeIndex = 0;
  g.frameCounter = 0;
  release(g.fence);
  if (g.fenceHandle) {
    CloseHandle(g.fenceHandle);
    g.fenceHandle = nullptr;
  }
  release(g.context4);
  release(g.context);
  release(g.device5);
  release(g.device1);
  release(g.device);
  g.fenceValue = 0;
}

// start(config?) -> boolean
Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g.device) teardown();

  D3D_FEATURE_LEVEL fl;
  if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
                               D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                               D3D11_SDK_VERSION, &g.device, &fl,
                               &g.context))) {
    Napi::Error::New(env, "D3D11CreateDevice failed")
        .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }
  g.device->QueryInterface(IID_PPV_ARGS(&g.device1));
  g.device->QueryInterface(IID_PPV_ARGS(&g.device5));
  g.context->QueryInterface(IID_PPV_ARGS(&g.context4));
  if (!g.device1 || !g.device5 || !g.context4) {
    teardown();
    Napi::Error::New(env, "Requires D3D11.1/11.4 (Win10+)")
        .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  int64_t luid = 0;
  IDXGIDevice* dxgiDevice = nullptr;
  IDXGIAdapter* adapter = nullptr;
  if (SUCCEEDED(g.device->QueryInterface(IID_PPV_ARGS(&dxgiDevice))) &&
      SUCCEEDED(dxgiDevice->GetAdapter(&adapter))) {
    DXGI_ADAPTER_DESC desc{};
    adapter->GetDesc(&desc);
    luid = (int64_t)((uint64_t)desc.AdapterLuid.HighPart << 32 |
                     (uint32_t)desc.AdapterLuid.LowPart);
  }
  release(adapter);
  release(dxgiDevice);

  if (FAILED(g.device5->CreateFence(0, D3D11_FENCE_FLAG_SHARED,
                                    IID_PPV_ARGS(&g.fence)))) {
    teardown();
    Napi::Error::New(env, "CreateFence failed").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }
  g.fence->CreateSharedHandle(nullptr, GENERIC_ALL, nullptr, &g.fenceHandle);

  g.mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                 0, sizeof(IrdashiesShmHeader),
                                 IRDASHIES_SHM_MAPPING_NAME);
  if (!g.mapping) {
    teardown();
    Napi::Error::New(env, "CreateFileMapping failed")
        .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }
  g.shm = (IrdashiesShmHeader*)MapViewOfFile(g.mapping, FILE_MAP_WRITE, 0, 0,
                                             sizeof(IrdashiesShmHeader));
  if (!g.shm) {
    teardown();
    Napi::Error::New(env, "MapViewOfFile failed").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }
  g.mutex = CreateMutexW(nullptr, FALSE, IRDASHIES_SHM_MUTEX_NAME);

  ZeroMemory(g.shm, sizeof(*g.shm));
  g.shm->magic = IRDASHIES_SHM_MAGIC;
  g.shm->version = IRDASHIES_SHM_VERSION;
  g.shm->feederProcessId = GetCurrentProcessId();
  g.shm->adapterLuid = luid;
  g.shm->fenceHandle = (uint64_t)(uintptr_t)g.fenceHandle;
  g.shm->ringSize = IRDASHIES_SHM_RING_SIZE;
  if (info.Length() > 0 && info[0].IsObject()) {
    writePose(info[0].As<Napi::Object>());
  } else {
    Napi::Object empty = Napi::Object::New(env);
    writePose(empty);
  }
  return Napi::Boolean::New(env, true);
}

uint32_t readUint(const Napi::Object& obj, const char* key, uint32_t def) {
  if (obj.Has(key) && obj.Get(key).IsNumber()) {
    return obj.Get(key).As<Napi::Number>().Uint32Value();
  }
  return def;
}

// submitFrame(textureInfo) -> boolean
Napi::Value SubmitFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (!g.device || !g.shm) return Napi::Boolean::New(env, false);
  if (info.Length() < 1 || !info[0].IsObject()) {
    return Napi::Boolean::New(env, false);
  }
  Napi::Object textureInfo = info[0].As<Napi::Object>();

  // The NT handle location moved across Electron versions: current (>=~33)
  // nests it at textureInfo.handle.ntHandle; older builds exposed
  // textureInfo.sharedTextureHandle directly. Support both.
  HANDLE srcHandle = nullptr;
  bool gotHandle = false;
  auto tryBuffer = [&](Napi::Value v) {
    if (gotHandle || !v.IsBuffer()) return;
    Napi::Buffer<uint8_t> b = v.As<Napi::Buffer<uint8_t>>();
    if (b.Length() >= sizeof(HANDLE)) {
      srcHandle = *reinterpret_cast<HANDLE*>(b.Data());
      gotHandle = true;
    }
  };
  Napi::Value handle = textureInfo.Get("handle");
  if (handle.IsObject()) {
    tryBuffer(handle.As<Napi::Object>().Get("ntHandle"));
  }
  tryBuffer(textureInfo.Get("sharedTextureHandle"));
  if (!gotHandle) {
    static bool logged = false;
    if (!logged) {
      logged = true;
      producerLog(
          "no NT handle in textureInfo (checked handle.ntHandle and "
          "sharedTextureHandle)");
    }
    return Napi::Boolean::New(env, false);
  }

  ID3D11Texture2D* srcTex = nullptr;
  if (FAILED(g.device1->OpenSharedResource1(srcHandle,
                                            IID_PPV_ARGS(&srcTex)))) {
    static bool logged = false;
    if (!logged) {
      logged = true;
      producerLog(
          "OpenSharedResource1 failed - Chromium GPU adapter likely differs "
          "from the producer device adapter");
    }
    return Napi::Boolean::New(env, false);
  }
  D3D11_TEXTURE2D_DESC sd{};
  srcTex->GetDesc(&sd);

  // The actual content lives in visibleRect; the texture may be padded to a
  // larger codedSize. Crop to visibleRect, clamped to the texture extent.
  uint32_t vx = 0, vy = 0, vw = sd.Width, vh = sd.Height;
  if (textureInfo.Has("visibleRect") &&
      textureInfo.Get("visibleRect").IsObject()) {
    Napi::Object r = textureInfo.Get("visibleRect").As<Napi::Object>();
    vx = readUint(r, "x", 0);
    vy = readUint(r, "y", 0);
    vw = readUint(r, "width", sd.Width);
    vh = readUint(r, "height", sd.Height);
  }
  if (vx >= sd.Width || vy >= sd.Height) {
    release(srcTex);
    return Napi::Boolean::New(env, false);
  }
  if (vx + vw > sd.Width) vw = sd.Width - vx;
  if (vy + vh > sd.Height) vh = sd.Height - vy;

  // Advance to the next slot first, so latestIndex keeps pointing at the
  // frame the consumer may still be reading.
  g.writeIndex = (g.writeIndex + 1) % IRDASHIES_SHM_RING_SIZE;
  Slot& slot = g.slots[g.writeIndex];

  // (Re)create this slot's texture if size/format changed.
  if (!slot.texture || slot.width != vw || slot.height != vh ||
      slot.format != sd.Format) {
    release(slot.texture);
    if (slot.handle) {
      CloseHandle(slot.handle);
      slot.handle = nullptr;
    }

    D3D11_TEXTURE2D_DESC td{};
    td.Width = vw;
    td.Height = vh;
    td.MipLevels = 1;
    td.ArraySize = 1;
    td.Format = sd.Format;
    td.SampleDesc.Count = 1;
    td.Usage = D3D11_USAGE_DEFAULT;
    td.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    td.MiscFlags =
        D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
    if (FAILED(g.device->CreateTexture2D(&td, nullptr, &slot.texture))) {
      release(srcTex);
      return Napi::Boolean::New(env, false);
    }
    IDXGIResource1* res = nullptr;
    if (SUCCEEDED(slot.texture->QueryInterface(IID_PPV_ARGS(&res)))) {
      res->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ, nullptr,
                              &slot.handle);
    }
    release(res);
    slot.width = vw;
    slot.height = vh;
    slot.format = sd.Format;
    producerLog("created shared texture slot %u: %ux%u format=%u", g.writeIndex,
                vw, vh, (unsigned)sd.Format);

    if (g.mutex) WaitForSingleObject(g.mutex, INFINITE);
    g.shm->frames[g.writeIndex].textureHandle = (uint64_t)(uintptr_t)slot.handle;
    g.shm->frames[g.writeIndex].width = vw;
    g.shm->frames[g.writeIndex].height = vh;
    g.shm->frames[g.writeIndex].format = (uint32_t)sd.Format;
    if (g.mutex) ReleaseMutex(g.mutex);
  }

  D3D11_BOX box{};
  box.left = vx;
  box.top = vy;
  box.front = 0;
  box.right = vx + vw;
  box.bottom = vy + vh;
  box.back = 1;
  g.context->CopySubresourceRegion(slot.texture, 0, 0, 0, 0, srcTex, 0, &box);
  release(srcTex);

  ++g.fenceValue;
  g.context4->Signal(g.fence, g.fenceValue);
  g.context->Flush();

  ++g.frameCounter;
  if (g.mutex) WaitForSingleObject(g.mutex, INFINITE);
  g.shm->frames[g.writeIndex].frameNumber = g.frameCounter;
  g.shm->fenceValue = g.fenceValue;
  g.shm->latestIndex = g.writeIndex;
  g.shm->flags |= IRDASHIES_SHM_FLAG_FEEDER_ATTACHED;
  g.shm->layerCount = g.layerCount;
  for (uint32_t i = 0; i < g.layerCount && i < IRDASHIES_SHM_MAX_LAYERS; ++i) {
    g.shm->layers[i] = g.layers[i];
  }
  if (g.mutex) ReleaseMutex(g.mutex);

  static bool firstOk = false;
  if (!firstOk) {
    firstOk = true;
    producerLog("first frame published slot=%u %ux%u", g.writeIndex, vw, vh);
  }
  return Napi::Boolean::New(env, true);
}

// setPose(pose) -> void
Napi::Value SetPose(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g.shm && info.Length() > 0 && info[0].IsObject()) {
    if (g.mutex) WaitForSingleObject(g.mutex, INFINITE);
    writePose(info[0].As<Napi::Object>());
    if (g.mutex) ReleaseMutex(g.mutex);
  }
  return env.Undefined();
}

// setLayers(layers) -> void
// Publish per-widget layer config (poses, sub-rects, opacity).
Napi::Value SetLayers(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsArray()) return env.Undefined();
  Napi::Array arr = info[0].As<Napi::Array>();
  uint32_t n = arr.Length();
  if (n > IRDASHIES_SHM_MAX_LAYERS) n = IRDASHIES_SHM_MAX_LAYERS;

  if (g.mutex) WaitForSingleObject(g.mutex, INFINITE);
  for (uint32_t i = 0; i < n; ++i) {
    Napi::Value v = arr.Get(i);
    if (!v.IsObject()) continue;
    Napi::Object obj = v.As<Napi::Object>();
    auto readFloatArr = [&](const char* key, float* out, int count) {
      if (obj.Has(key) && obj.Get(key).IsArray()) {
        Napi::Array a = obj.Get(key).As<Napi::Array>();
        for (int j = 0; j < count; ++j)
          out[j] = (j < (int)a.Length()) ? a.Get(j).As<Napi::Number>().FloatValue() : 0.0f;
      }
    };
    readFloatArr("position", g.layers[i].posePosition, 3);
    readFloatArr("orientation", g.layers[i].poseOrientation, 4);
    readFloatArr("size", g.layers[i].quadSizeMeters, 2);
    readFloatArr("sourceRect", g.layers[i].sourceRect, 4);
    g.layers[i].opacity =
        obj.Has("opacity") ? obj.Get("opacity").As<Napi::Number>().FloatValue() : 1.0f;
    g.layers[i].visible =
        obj.Has("visible") ? obj.Get("visible").As<Napi::Number>().Uint32Value() : 1u;
  }
  g.layerCount = n;
  if (g.mutex) ReleaseMutex(g.mutex);

  return env.Undefined();
}

// recenter() -> void
// Signal the consumer (OpenXR layer) to reposition the quad to the current
// head pose. The consumer recenters when the counter changes.
Napi::Value Recenter(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g.shm) {
    if (g.mutex) WaitForSingleObject(g.mutex, INFINITE);
    g.shm->recenterCounter++;
    if (g.mutex) ReleaseMutex(g.mutex);
  }
  return env.Undefined();
}

// stop() -> void
Napi::Value Stop(const Napi::CallbackInfo& info) {
  teardown();
  return info.Env().Undefined();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("start", Napi::Function::New(env, Start));
  exports.Set("submitFrame", Napi::Function::New(env, SubmitFrame));
  exports.Set("setPose", Napi::Function::New(env, SetPose));
  exports.Set("setLayers", Napi::Function::New(env, SetLayers));
  exports.Set("recenter", Napi::Function::New(env, Recenter));
  exports.Set("stop", Napi::Function::New(env, Stop));
  return exports;
}

}  // namespace

NODE_API_MODULE(vr_overlay, Init)
