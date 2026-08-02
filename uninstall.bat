@echo off
net session >nul 2>&1
if %errorlevel% neq 0 (powershell -Command "Start-Process '%~f0' -Verb RunAs" & exit /b)
set "DIR=%ProgramFiles%\irDashies\openxr-layer"
reg delete "HKLM\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit" /v "%DIR%\irDashies-OpenXR.json" /f >nul 2>&1
if exist "%DIR%" rmdir /s /q "%DIR%" 2>nul
echo Uninstalled. & pause
