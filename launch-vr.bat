@echo off
setlocal

set "APP=%~dp0app\irdashies.exe"
set "PS=%~dp0app\resources\register-openxr.ps1"
set "DLL=%~dp0app\resources\irDashies-OpenXR-Layer.dll"

:: Check if the OpenXR layer is already registered (no admin required)
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%" -SourceDll "%DLL%" -CheckOnly >nul 2>&1
if %errorlevel% equ 0 (
    echo OpenXR layer already registered, skipping.
    goto launch
)

:: Register the OpenXR API layer (requires admin, will prompt UAC)
echo Registering OpenXR layer...
powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%PS%\" -SourceDll \"%DLL%\"' -Verb RunAs -Wait"

:launch
set "IRDASHIES_VR=1"
echo Launching irDashies with VR enabled...
start "" "%APP%"

endlocal
