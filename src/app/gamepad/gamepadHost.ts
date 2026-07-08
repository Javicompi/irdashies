import { BrowserWindow, ipcMain, session } from 'electron';
import path from 'node:path';
import logger from '../logger';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;

const BUTTON_CHANNEL = 'gamepad:button';
const HID_PARTITION = 'hid-host';

export class GamepadHost {
  private window?: BrowserWindow;
  private onButton?: (token: string, down: boolean) => void;
  private permissionsGranted = false;
  private readonly handleButton = (
    event: Electron.IpcMainEvent,
    token: string,
    down: boolean
  ): void => {
    if (event.sender.id !== this.window?.webContents.id) return;
    this.onButton?.(token, down);
  };

  start(onButton: (token: string, down: boolean) => void): void {
    this.onButton = onButton;
    if (this.window && !this.window.isDestroyed()) return;

    this.grantHidPermissions();
    ipcMain.removeListener(BUTTON_CHANNEL, this.handleButton);
    ipcMain.on(BUTTON_CHANNEL, this.handleButton);

    this.window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        backgroundThrottling: false,
        partition: HID_PARTITION,
      },
    });

    this.window.webContents.on('did-fail-load', (_e, code, desc, url) =>
      logger.error(`[Gamepad] HID host failed to load ${url}: ${code} ${desc}`)
    );

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const base = MAIN_WINDOW_VITE_DEV_SERVER_URL.replace(/\/$/, '');
      this.window.loadURL(`${base}/index-hid-host.html`);
    } else {
      this.window.loadFile(
        path.join(
          __dirname,
          `../renderer/${MAIN_WINDOW_VITE_NAME}/index-hid-host.html`
        )
      );
    }

    logger.info('[Gamepad] WebHID host window started');
  }

  stop(): void {
    ipcMain.removeListener(BUTTON_CHANNEL, this.handleButton);
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
    }
    this.window = undefined;
  }

  private grantHidPermissions(): void {
    if (this.permissionsGranted) return;
    this.permissionsGranted = true;

    const ses = session.fromPartition(HID_PARTITION);
    ses.setPermissionCheckHandler(() => true);
    ses.setDevicePermissionHandler(() => true);
    ses.on('select-hid-device', (event, details, callback) => {
      event.preventDefault();
      callback(details.deviceList[0]?.deviceId);
    });
  }
}
