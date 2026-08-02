import { app, ipcMain } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../logger';

/**
 * Bridge for registering / unregistering the OpenXR API layer (the logic that
 * used to live in `launch-vr.bat` + `scripts/register-openxr.ps1`).
 *
 * - `checkLayer` runs the registration script in `-CheckOnly` mode (no admin).
 * - `registerLayer` / `unregisterLayer` re-launch PowerShell elevated (UAC).
 */

function getRegisterScriptPath(): string {
  // Packaged: forge copies scripts/* to resources/ via extraResource.
  const packaged = path.join(process.resourcesPath, 'register-openxr.ps1');
  if (fs.existsSync(packaged)) return packaged;
  // Dev: repo scripts folder.
  return path.join(app.getAppPath(), 'scripts', 'register-openxr.ps1');
}

function getUnregisterScriptPath(): string {
  const packaged = path.join(process.resourcesPath, 'unregister-openxr.ps1');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(app.getAppPath(), 'scripts', 'unregister-openxr.ps1');
}

function getLayerDllPath(): string {
  // Packaged: forge copies the DLL to resources/ via extraResource.
  const packaged = path.join(
    process.resourcesPath,
    'irDashies-OpenXR-Layer.dll'
  );
  if (fs.existsSync(packaged)) return packaged;
  // Dev: native build output.
  return path.join(
    app.getAppPath(),
    'native',
    'openxr-layer',
    'build',
    'Release',
    'irDashies-OpenXR-Layer.dll'
  );
}

function runPowerShellElevated(script: string, args: string[]): Promise<void> {
  const argList = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    `"${script}"`,
    ...args,
  ];
  return new Promise((resolve) => {
    const child = spawn(
      'powershell',
      [
        '-Command',
        `Start-Process powershell -ArgumentList '${argList.join(' ')}' -Verb RunAs -Wait`,
      ],
      { windowsHide: false }
    );
    child.on('close', () => resolve());
    child.on('error', (err) => {
      logger.error('[OpenXR] failed to spawn elevated PowerShell', err);
      resolve();
    });
  });
}

async function checkLayer(): Promise<boolean | null> {
  const script = getRegisterScriptPath();
  const dll = getLayerDllPath();
  if (!fs.existsSync(script) || !fs.existsSync(dll)) return null;

  return new Promise((resolve) => {
    const child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-SourceDll',
        dll,
        '-CheckOnly',
      ],
      { windowsHide: true }
    );
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(null));
  });
}

async function registerLayer(): Promise<boolean> {
  const script = getRegisterScriptPath();
  const dll = getLayerDllPath();
  if (!fs.existsSync(script) || !fs.existsSync(dll)) return false;
  await runPowerShellElevated(script, ['-SourceDll', `"${dll}"`]);
  return (await checkLayer()) === true;
}

async function unregisterLayer(): Promise<boolean> {
  const script = getUnregisterScriptPath();
  if (!fs.existsSync(script)) return false;
  await runPowerShellElevated(script, []);
  return (await checkLayer()) === false;
}

export function setupOpenXRBridge(): void {
  ipcMain.handle('openxr:check', () => checkLayer());
  ipcMain.handle('openxr:register', () => registerLayer());
  ipcMain.handle('openxr:unregister', () => unregisterLayer());
}
