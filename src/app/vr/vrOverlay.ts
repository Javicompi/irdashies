import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
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

// Supersampling: render the overlay at N x the display's pixel dimensions so the
// quad has more texels and aliases less in the headset. The page still lays out
// as if at the display size (via zoom factor); only the backing texture grows.
// Caps at 2048 because VR runtimes reject swapchains above 4096 (and 2048 is
// already very dense for a 1.8m-wide quad — ~1138 texels/m).
const VR_SUPERSAMPLE = 8;
const VR_MAX_TEXTURE_DIM = 2048;

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
let liveEditPosition: [number, number, number] = [0, 0, -1.5];

const DEFAULT_POSE: Required<VrPose> = {
  position: [0, 0, -1.5],
  orientation: [0, 0, 0, 1],
  size: [0.5, 0.5],
};

function getWidgetVrPosition(
  widgetId: string,
  globalPose: VrPose
): [number, number, number] {
  if (vrEditMode && widgetId === selectedWidgetId) return liveEditPosition;
  const widget = currentDashboard?.widgets.find((w) => w.id === widgetId);
  const def = globalPose.position ?? DEFAULT_POSE.position;
  const pos = widget?.vrPosition;
  return pos ? [pos[0], pos[1], pos[2]] : [def[0], def[1], def[2]];
}

function publishVrLayers(): void {
  if (!osrWindow) return;
  const pose = currentVrPose ?? DEFAULT_POSE;

  if (vrEditMode) {
    // Edit mode: one quad per VR widget, each with its own pose.
    const globalPos = pose.position ?? DEFAULT_POSE.position;
    const layers = atlasLayout.map((slot) => ({
      position: getWidgetVrPosition(slot.widgetId, pose),
      orientation: pose.orientation ?? DEFAULT_POSE.orientation,
      size: pose.size ?? DEFAULT_POSE.size,
      sourceRect: slot.sourceRect,
      opacity: 1,
      visible: 1,
    }));
    // Instructions overlay as a fixed quad at the bottom of the atlas.
    const instrH = 200;
    layers.push({
      position: [0, -0.15, -1.2],
      orientation: [0, 0, 0, 1],
      size: pose.size ?? DEFAULT_POSE.size,
      sourceRect: [0, atlasTexH - instrH, atlasTexW, instrH],
      opacity: 1,
      visible: 1,
    });
    VrOverlayNative.setLayers(layers);
    return;
  }

  // Normal mode: single full-atlas quad.
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
    if (!globalShortcut.isRegistered(accel)) globalShortcut.register(accel, handler);
  };
  reg('Space', () => cycleSelectedWidget());
  reg('Left',  () => moveSelected(-0.01, 0, 0));
  reg('Right', () => moveSelected( 0.01, 0, 0));
  reg('Up',    () => moveSelected(0,  0.01, 0));
  reg('Down',  () => moveSelected(0, -0.01, 0));
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
      w.id === selectedWidgetId ? { ...w, vrPosition: liveEditPosition } : w
    ),
  };
}

function saveVrPositionsToDashboard(): void {
  commitLivePositionToDashboard();
  if (!currentDashboard) return;
  saveDashboard(getCurrentProfileId(), currentDashboard);
  // Note: saveDashboard emits onDashboardUpdated, which calls
  // applyVrOverlaySettings → publishVrLayers again (idempotent).
}

function toggleVrEditMode(): void {
  if (!osrWindow || osrWindow.isDestroyed()) return;
  vrEditMode = !vrEditMode;

  if (vrEditMode) {
    selectedWidgetIndex = 0;
    selectedWidgetId = atlasLayout[0]?.widgetId ?? null;
    if (selectedWidgetId) {
      liveEditPosition = getWidgetVrPosition(selectedWidgetId, currentVrPose ?? DEFAULT_POSE);
    }
    registerEditKeys();
    logger.info('[VR] edit mode ON');
  } else {
    unregisterEditKeys();
    saveVrPositionsToDashboard();
    selectedWidgetId = null;
    logger.info('[VR] edit mode OFF');
  }

  osrWindow.webContents.send('vr-edit-mode', vrEditMode, selectedWidgetId, liveEditPosition);
  publishVrLayers();
}

function cycleSelectedWidget(): void {
  if (!vrEditMode || atlasLayout.length === 0) return;
  commitLivePositionToDashboard();
  selectedWidgetIndex = (selectedWidgetIndex + 1) % atlasLayout.length;
  selectedWidgetId = atlasLayout[selectedWidgetIndex].widgetId;
  liveEditPosition = getWidgetVrPosition(selectedWidgetId, currentVrPose ?? DEFAULT_POSE);
  if (osrWindow && !osrWindow.isDestroyed()) {
    osrWindow.webContents.send('vr-edit-select', selectedWidgetId, liveEditPosition);
  }
}

function moveSelected(dx: number, dy: number, dz: number): void {
  if (!vrEditMode || !selectedWidgetId) return;
  liveEditPosition = [
    +(liveEditPosition[0] + dx).toFixed(3),
    +(liveEditPosition[1] + dy).toFixed(3),
    +(liveEditPosition[2] + dz).toFixed(3),
  ];
  if (osrWindow && !osrWindow.isDestroyed()) {
    osrWindow.webContents.send('vr-edit-move', liveEditPosition);
  }
  publishVrLayers();
}

export function updateVrDashboard(dashboard: DashboardLayout): void {
  currentDashboard = dashboard;
}

// ----------------------------------------------------------------
ipcMain.on('vr-atlas-layout', (_event, layers: AtlasLayer[]) => {
  atlasLayout = layers;
  publishVrLayers();
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

  // Lay out at the primary display size (so widget pixel coordinates land where
  // intended) but render into a larger backing texture for supersampling.
  const { width: displayW, height: displayH } = screen.getPrimaryDisplay().size;
  let scale = Math.min(
    VR_SUPERSAMPLE,
    VR_MAX_TEXTURE_DIM / Math.max(displayW, displayH)
  );
  scale = Math.max(1, scale);
  const texW = Math.round(displayW * scale);
  const texH = Math.round(displayH * scale);
  atlasTexW = texW;
  atlasTexH = texH;
  const zoomFactor = texW / displayW;

  quadAspect = displayH / displayW;
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

  // Register F9 for VR edit mode (only while VR is active).
  if (!globalShortcut.isRegistered('F9')) globalShortcut.register('F9', toggleVrEditMode);

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
  unregisterEditKeys();
  if (globalShortcut.isRegistered('F9')) globalShortcut.unregister('F9');
  vrEditMode = false;
}
