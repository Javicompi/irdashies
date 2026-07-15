@echo off
setlocal

:: Register the OpenXR API layer (requires admin, will prompt UAC)
echo Registering OpenXR layer...
powershell -Command "Start-Process powershell -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"%~dp0resources\register-openxr.ps1\" -SourceDll \"%~dp0resources\irDashies-OpenXR-Layer.dll\"' -Verb RunAs -Wait"

set "IRDASHIES_VR=1"
echo Launching irDashies with VR enabled...
start "" "%~dp0irdashies.exe"

endlocal
