---
name: irdashies-zip
description: Empaqueta la app Electron irDashies, la DLL de OpenXR y los scripts .bat en el archivo out/irdashies-vr.zip para pruebas en otro PC.
---

# irDashies VR ZIP build

Genera un zip auto-contenido con la app empaquetada, la DLL de OpenXR y los batch files para probar en otro PC sin instalar.

## How to generate

```powershell
# 1. Build the Electron app
npm run package

# 2. Build the OpenXR layer DLL (if needed/not already built)
npm run build:openxr

# 3. Create staging directory and ZIP
$staging = "$env:TEMP\irdashies-staging"

# Clean previous staging runs if present
if (Test-Path $staging) { Remove-Item -Path $staging -Recurse -Force }

mkdir "$staging\app", "$staging\openxr-layer"

# Copy packaged app into app/ folder
Copy-Item -Recurse "out\irdashies-win32-x64\*" "$staging\app\"

# Copy OpenXR DLL to openxr-layer/ (used by setup.bat)
Copy-Item "native\openxr-layer\build\Release\irDashies-OpenXR-Layer.dll" "$staging\openxr-layer\"

# Copy batch launchers to root
Copy-Item launch.bat, launch-vr.bat, setup.bat, uninstall.bat "$staging\"

# Create ZIP (overwriting existing)
Compress-Archive -Path "$staging\*" -DestinationPath "out\irdashies-vr.zip" -Force

# Clean staging folder after compression
Remove-Item -Path $staging -Recurse -Force
```

## ZIP contents

```
app/                          # Packaged Electron app (from out/irdashies-win32-x64/)
  irdashies.exe               # Main executable
  resources/
    app.asar                  # Application code bundle
    irDashies-OpenXR-Layer.dll # OpenXR layer (copied by forge extraResource)
    register-openxr.ps1       # OpenXR registration script
  chrome_100_percent.pak      # Chromium resources
  chrome_200_percent.pak
  d3dcompiler_47.dll
  ffmpeg.dll
  libEGL.dll
  libGLESv2.dll
  locales/                    # Chromium locale files
  ... (other Electron runtime files)
openxr-layer/                 # OpenXR layer DLL for setup.bat
  irDashies-OpenXR-Layer.dll
launch.bat                    # Launch app normally
launch-vr.bat                 # Launch app with VR enabled (IRDASHIES_VR=1)
setup.bat                     # Admin script: register OpenXR layer in Windows
uninstall.bat                 # Admin script: unregister OpenXR layer
```

## Update process

When you make code changes:
1. Run `npm run package` to rebuild the Electron app
2. Re-run the ZIP generation script to regenerate the ZIP
3. The old `out/irdashies-vr.zip` is overwritten
