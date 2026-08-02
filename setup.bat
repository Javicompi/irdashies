@echo off
setlocal enabledelayedexpansion
set "ID=%ProgramFiles%\irDashies\openxr-layer"
net session >nul 2>&1
if %errorlevel% neq 0 (echo Admin... & powershell -Command "Start-Process '%~f0' -Verb RunAs" & exit /b)
set "S=%~dp0openxr-layer\irDashies-OpenXR-Layer.dll"
if not exist "%S%" (echo DLL no encontrada & pause & exit /b 1)
if not exist "%ID%" mkdir "%ID%"
copy /y "%S%" "%ID%" >nul
set "JS=%ID%\irDashies-OpenXR.json"
set "DP=%ID:\=/%/irDashies-OpenXR-Layer.dll"
(echo {&echo   "file_format_version":"1.0.0",&echo   "api_layer":{&echo     "name":"XR_APILAYER_IRDASHIES_overlay",&echo     "library_path":"%DP%",&echo     "api_version":"1.0",&echo     "implementation_version":"1",&echo     "description":"irDashies VR overlay",&echo     "functions":{&echo       "xrNegotiateLoaderApiLayerInterface":"irDashies_xrNegotiateLoaderApiLayerInterface"&echo     },&echo     "disable_environment":"DISABLE_IRDASHIES_OPENXR"&echo   }&echo })>"%JS%"
reg add "HKLM\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit" /v "%JS%" /t REG_DWORD /d 0 /f >nul 2>&1
echo OK.
pause
