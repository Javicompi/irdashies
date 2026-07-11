import { BrowserWindow, globalShortcut, ipcMain } from 'electron';
import path from 'path';
import logger from '../logger';
import type { OverlayManager } from '../overlayManager';
import { saveDashboard, getCurrentProfileId } from '../storage/dashboards';
import {
  DEFAULT_VR_OVERLAY_SETTINGS,
  type VrOverlaySettings,
} from '@irdashies/types';
import type { DashboardLayout } from '@irdashies/types';
import { VrOverlayNative, type VrPose } from './native';

// Injected by the forge vite plugin (same globals overlayManager uses).
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

// Fixed VR atlas size — large canvas for free widget placement.
// 3840x2160 (4K) gives plenty of room, well under the 4096 swapchain limit.
const VR_ATLAS_WIDTH = 3840;
const VR_ATLAS_HEIGHT = 2160;

let osrWindow: BrowserWindow | null = null;
let overlayManagerRef: OverlayManager | null = null;

// Per-widget atlas layout reported by the VR atlas page. Stored for the
// future per-widget quad path; the MVP publishes a single full-atlas layer.
interface AtlasLayer {
  widgetId: string;
  sourceRect: [number, number, number, number];
}
let atlasLayout: AtlasLayer[] = [];
let currentVrPose: VrPose | undefined;
let currentDashboard: DashboardLayout | undefined;

// VR edit-mode state (session-only, persisted to dashboard on exit).
let vrEditMode = false;
let selectedWidgetIndex = 0;
let selectedWidgetId: string | null = null;
let liveEditX = 0;
let liveEditY = 0;
let liveEditZ = -1.5;

const DEFAULT_POSE: Required<VrPose> = {
  position: [0, 0, -1.5],
  orientation: [0, 0, 0, 1],
  size: [0.5, 0.5],
};

function getWidgetAtlasPos(widgetId: string): [number, number] {
  // Check saved position first.
  const widget = currentDashboard?.widgets.find((w) => w.id === widgetId);
  if (widget?.vrAtlasX != null && widget?.vrAtlasY != null) {
    return [widget.vrAtlasX, widget.vrAtlasY];
  }
  // Fall back to current atlas slot position (from VrAtlasContainer report).
  const slot = atlasLayout.find((s) => s.widgetId === widgetId);
  if (slot) return [slot.sourceRect[0], slot.sourceRect[1]];
  return [0, 0];
}

function publishVrLayers(): void {
  if (!osrWindow) return;
  const pose = currentVrPose ?? DEFAULT_POSE;

  // Always publish a single full-atlas layer. In edit mode, the VR atlas page
  // renders green borders + instructions directly into the atlas texture, so
  // the consumer sees everything in one quad. Per-widget quads are deferred
  // until we have stable multi-quad consumer behaviour.
  VrOverlayNative.setLayers([
    {
      position: pose.position ?? DEFAULT_POSE.position,
      orientation: pose.orientation ?? DEFAULT_POSE.orientation,
      size: pose.size ?? DEFAULT_POSE.size,
      sourceRect: [0, 0, atlasTexW, atlasTexH],
      opacity: 1,
      visible: 1,
    },
  ]);
}

// --------------- VR Edit Mode (per-widget positioning) ---------------

let editKeysRegistered = false;

function registerEditKeys(): void {
  if (editKeysRegistered) return;
  editKeysRegistered = true;
  const reg = (accel: string, handler: () => void) => {
    // Unregister first so our handler takes precedence over any existing
    // KeybindingManager registration during edit mode.
    if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
    globalShortcut.register(accel, handler);
  };
  const PX = 10;
  reg('Space', () => cycleSelectedWidget());
  reg('Left',  () => moveSelected(-PX, 0, 0));
  reg('Right', () => moveSelected( PX, 0, 0));
  reg('Up',    () => moveSelected(0, -PX, 0));
  reg('Down',  () => moveSelected(0,  PX, 0));
  reg('Q',     () => moveSelected(0, 0, -0.01));
  reg('E',     () => moveSelected(0, 0,  0.01));
}

function unregisterEditKeys(): void {
  if (!editKeysRegistered) return;
  editKeysRegistered = false;
  for (const accel of ['Space', 'Left', 'Right', 'Up', 'Down', 'Q', 'E']) {
    if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
  }
}

function commitLivePositionToDashboard(): void {
  if (!currentDashboard || !selectedWidgetId) return;
  currentDashboard = {
    ...currentDashboard,
    widgets: currentDashboard.widgets.map((w) =>
      w.id === selectedWidgetId
        ? { ...w, vrAtlasX: liveEditX, vrAtlasY: liveEditY }
        : w
    ),
  };
}

function saveVrEditPositions(): void {
  commitLivePositionToDashboard();
  if (!currentDashboard) return;
  const z = -liveEditZ;
  const vrSettings: VrOverlaySettings = {
    ...DEFAULT_VR_OVERLAY_SETTINGS,
    width: currentVrPose?.size?.[0] ?? DEFAULT_POSE.size[0],
    distance: z,
    horizontal: currentVrPose?.position?.[0] ?? 0,
    vertical: currentVrPose?.position?.[1] ?? 0,
  };
  currentDashboard = {
    ...currentDashboard,
    generalSettings: { ...currentDashboard.generalSettings, vr: vrSettings },
  };
  saveDashboard(getCurrentProfileId(), currentDashboard);
}

function notifyRenderer() {
  if (!osrWindow || osrWindow.isDestroyed()) return;
  osrWindow.webContents.executeJavaScript(
    `window.__vrEdit={active:${vrEditMode},id:'${selectedWidgetId ?? ''}',` +
    `x:${liveEditX},y:${liveEditY},z:${liveEditZ}};` +
    `window.dispatchEvent(new CustomEvent('vr-edit-state',{detail:window.__vrEdit}));`
  ).catch(() => {});
}

function toggleVrEditMode(): void {
  logger.info('[VR] toggleEdit: entering=%s osrWindow=%s', vrEditMode ? 'exit' : 'enter', osrWindow ? 'exists' : 'null');
  if (!osrWindow || osrWindow.isDestroyed()) return;
  vrEditMode = !vrEditMode;

  if (vrEditMode) {
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
    unregisterEditKeys();
    saveVrEditPositions();
    selectedWidgetId = null;
    logger.info('[VR] edit mode OFF');
  }

  notifyRenderer();
  publishVrLayers();
}

function cycleSelectedWidget(): void {
  if (!vrEditMode || atlasLayout.length === 0) return;
  commitLivePositionToDashboard();
  selectedWidgetIndex = (selectedWidgetIndex + 1) % atlasLayout.length;
  selectedWidgetId = atlasLayout[selectedWidgetIndex].widgetId;
  if (selectedWidgetId) {
    const [x, y] = getWidgetAtlasPos(selectedWidgetId);
    liveEditX = x; liveEditY = y;
    liveEditZ = currentVrPose?.position?.[2] ?? DEFAULT_POSE.position[2];
  }
  notifyRenderer();
}

function moveSelected(dx: number, dy: number, dz: number): void {
  if (!vrEditMode || !selectedWidgetId) return;

  if (dx !== 0 || dy !== 0) {
    liveEditX = Math.max(0, Math.min(liveEditX + dx, atlasTexW - 1));
    liveEditY = Math.max(0, Math.min(liveEditY + dy, atlasTexH - 1));
    notifyRenderer();
  }

  if (dz !== 0) {
    liveEditZ = Math.max(-4, Math.min(liveEditZ + dz, -0.5));
    // Debounce: only update the shared pose every 100ms to avoid flooding
    // setPose/publishVrLayers on every key repeat.
    if (!moveSelected._zTimer) {
      moveSelected._zTimer = setTimeout(() => {
        moveSelected._zTimer = undefined;
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
(moveSelected as any)._zTimer = undefined as NodeJS.Timeout | undefined;

export function updateVrDashboard(dashboard: DashboardLayout): void {
  currentDashboard = dashboard;
}

/** Register F9 for VR edit mode. Called from main.ts after KeybindingManager. */
export function registerVrEditKeys(): void {
  const accel = 'CommandOrControl+Shift+F9';
  if (!globalShortcut.isRegistered(accel)) {
    const ok = globalShortcut.register(accel, toggleVrEditMode);
    if (!ok) {
      logger.error('[VR] Failed to register %s for edit mode', accel);
    } else {
      logger.info('[VR] %s registered for edit mode', accel);
    }
  }
}

// ----------------------------------------------------------------
ipcMain.on('vr-atlas-layout', (_event, layers: AtlasLayer[]) => {
  atlasLayout = layers;
});

// Quad height follows the primary display aspect (height / width) so the texture
// is never stretched. Captured at start; needed to recompute size on the fly.
let quadAspect = 9 / 16;
let atlasTexW = 1920;
let atlasTexH = 1080;

/**
 * Build a native pose from user settings. The offscreen surface matches the
 * primary display so widget pixel layouts land 1:1; the quad's physical height
 * is derived from that aspect. Position is in metres, LOCAL space (z negative is
 * in front of the user); horizontal is +right, vertical is +up.
 */
function poseFromSettings(settings?: VrOverlaySettings): VrPose {
  const width = settings?.width ?? DEFAULT_VR_OVERLAY_SETTINGS.width;
  const distance = settings?.distance ?? DEFAULT_VR_OVERLAY_SETTINGS.distance;
  const horizontal =
    settings?.horizontal ?? DEFAULT_VR_OVERLAY_SETTINGS.horizontal;
  const vertical = settings?.vertical ?? DEFAULT_VR_OVERLAY_SETTINGS.vertical;
  return {
    position: [horizontal, vertical, -distance],
    orientation: [0, 0, 0, 1],
    size: [width, width * quadAspect],
  };
}

/**
 * MVP gate: VR overlay is opt-in via env var while it is experimental and not
 * wired into settings yet. Windows only (native addon + OpenXR layer).
 */
export function isVrOverlayEnabled(): boolean {
  return process.platform === 'win32' && process.env.IRDASHIES_VR === '1';
}

/**
 * Render the overlay offscreen and feed each GPU frame to the native producer,
 * which publishes it over shared memory to the OpenXR layer.
 */
export function startVrOverlay(
  overlayManager: OverlayManager,
  settings?: VrOverlaySettings
): void {
  if (osrWindow) return;

  overlayManagerRef = overlayManager;
  overlayManager.suppressDesktopOverlays();

  // Create the OSR window at the fixed atlas size.
  const texW = VR_ATLAS_WIDTH;
  const texH = VR_ATLAS_HEIGHT;
  const zoomFactor = 1;

  quadAspect = texH / texW;
  atlasTexW = texW;
  atlasTexH = texH;
  const pose = poseFromSettings(settings);
  currentVrPose = pose;

  try {
    if (!VrOverlayNative.start(pose)) {
      logger.error('[VR] native overlay start returned false');
      return;
    }
  } catch (err) {
    logger.error('[VR] failed to start native overlay', err);
    return;
  }

  const webPreferences = {
    preload: path.join(__dirname, 'preload.js'),
    backgroundThrottling: false,
    offscreen: { useSharedTexture: true },
  } as unknown as Electron.WebPreferences;

  osrWindow = new BrowserWindow({
    width: texW,
    height: texH,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences,
  });

  // Receive dashboard/telemetry/running broadcasts like a real overlay window
  // (it is not display/bounds managed, so it renders all enabled widgets).
  overlayManager.addExternalWindow(osrWindow);

  const wc = osrWindow.webContents;
  // Apply the supersample zoom on load: zoom shrinks the CSS viewport back to
  // the display size while the backing texture stays at texW x texH.
  wc.on('did-finish-load', () => {
    if (osrWindow && !osrWindow.isDestroyed()) wc.setZoomFactor(zoomFactor);
  });
  let loggedFirstPaint = false;
  let loggedNoTexture = false;
  wc.on('paint', (event) => {
    const texture = (
      event as unknown as {
        texture?: { textureInfo: unknown; release: () => void };
      }
    ).texture;

    if (!texture) {
      if (!loggedNoTexture) {
        loggedNoTexture = true;
        logger.warn(
          '[VR] paint has no GPU texture (useSharedTexture inactive - ' +
            'hardware acceleration off or GPU compositing disabled). ' +
            'CPU-only offscreen frames are not supported.'
        );
      }
      return;
    }

    if (!loggedFirstPaint) {
      loggedFirstPaint = true;
      const info = texture.textureInfo as {
        pixelFormat?: string;
        codedSize?: { width: number; height: number };
        visibleRect?: { width: number; height: number };
      };
      logger.info(
        `[VR] first GPU frame: format=${info.pixelFormat} ` +
          `coded=${info.codedSize?.width}x${info.codedSize?.height} ` +
          `visible=${info.visibleRect?.width}x${info.visibleRect?.height}`
      );
    }

    try {
      VrOverlayNative.submitFrame(texture.textureInfo);
    } catch (err) {
      logger.error('[VR] submitFrame failed', err);
    } finally {
      // Must release promptly or Chromium's frame pool drains and paints stop.
      texture.release();
    }
  });
  wc.setFrameRate(60);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    wc.loadURL(`${MAIN_WINDOW_VITE_DEV_SERVER_URL}#/vr-atlas`);
  } else {
    osrWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
      { hash: '/vr-atlas' }
    );
  }

  logger.info('[VR] overlay started (OSR -> shared memory -> OpenXR layer)');
  publishVrLayers();
}

/**
 * Push updated quad placement to the native layer without restarting. No-op if
 * VR is not running. Called whenever the dashboard's VR settings change.
 */
export function applyVrOverlaySettings(settings?: VrOverlaySettings): void {
  if (!osrWindow) return;
  const pose = poseFromSettings(settings);
  currentVrPose = pose;
  try {
    VrOverlayNative.setPose(pose);
    publishVrLayers();
  } catch (err) {
    logger.error('[VR] setPose failed', err);
  }
}

/**
 * Recenter the VR overlay quad to the user's current head pose. No-op if VR is
 * not running.
 */
export function recenterVrOverlay(): void {
  if (!osrWindow) return;
  try {
    VrOverlayNative.recenter();
  } catch (err) {
    logger.error('[VR] recenter failed', err);
  }
}

export function stopVrOverlay(): void {
  try {
    VrOverlayNative.stop();
  } catch (err) {
    logger.error('[VR] native stop failed', err);
  }
  if (osrWindow) {
    osrWindow.destroy();
    osrWindow = null;
  }
  overlayManagerRef?.restoreDesktopOverlays();
  overlayManagerRef = null;
  // Persist any unsaved edit-mode positions on shutdown.
  if (vrEditMode) saveVrEditPositions();
  unregisterEditKeys();
  if (globalShortcut.isRegistered('CommandOrControl+Shift+F9')) globalShortcut.unregister('CommandOrControl+Shift+F9');
  vrEditMode = false;
}
