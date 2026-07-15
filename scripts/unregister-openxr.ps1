param()

$ErrorActionPreference = 'Continue'

$layerDir = "$env:ProgramFiles\irDashies\openxr-layer"
$jsonDest = Join-Path $layerDir 'irDashies-OpenXR.json'

# Remove registry key
$regPath = 'HKLM:\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit'
if (Test-Path $regPath) {
    $regName = $jsonDest -replace '\\', '\\'
    Remove-ItemProperty -Path $regPath -Name $regName -Force -ErrorAction SilentlyContinue
    Write-Host 'Registry key removed.'
}

# Remove files
if (Test-Path $layerDir) {
    Remove-Item -Recurse -Force $layerDir -ErrorAction SilentlyContinue
    Write-Host "Removed $layerDir"
}

# Remove parent if empty
$parentDir = Split-Path $layerDir -Parent
if ((Test-Path $parentDir) -and (-not (Get-ChildItem $parentDir -ErrorAction SilentlyContinue))) {
    Remove-Item $parentDir -Force -ErrorAction SilentlyContinue
}

Write-Host 'OpenXR layer unregistered.'
