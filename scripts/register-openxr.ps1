param(
    [string]$SourceDll,
    [string]$LayerDir = "$env:ProgramFiles\irDashies\openxr-layer"
)

$ErrorActionPreference = 'Stop'
$dllDest = Join-Path $LayerDir 'irDashies-OpenXR-Layer.dll'
$jsonDest = Join-Path $LayerDir 'irDashies-OpenXR.json'

# Already registered?
if ((Test-Path $dllDest) -and (Test-Path $jsonDest)) {
    $key = 'HKLM:\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit'
    $name = $jsonDest -replace '\\', '\\'
    if (Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue) {
        Write-Host 'OpenXR layer already registered.'
        exit 0
    }
}

if (-not (Test-Path $SourceDll)) {
    Write-Error "DLL not found: $SourceDll"
    exit 1
}

# Create target directory
if (-not (Test-Path $LayerDir)) {
    New-Item -ItemType Directory -Path $LayerDir -Force | Out-Null
}

# Copy DLL
Copy-Item -Path $SourceDll -Destination $dllDest -Force
Write-Host "DLL copied to $dllDest"

# Create JSON manifest
$dllForward = ($LayerDir -replace '\\', '/') + '/irDashies-OpenXR-Layer.dll'
$json = @{
    file_format_version = '1.0.0'
    api_layer = @{
        name = 'XR_APILAYER_IRDASHIES_overlay'
        library_path = $dllForward
        api_version = '1.0'
        implementation_version = '1'
        description = 'irDashies VR overlay'
        functions = @{
            xrNegotiateLoaderApiLayerInterface = 'irDashies_xrNegotiateLoaderApiLayerInterface'
        }
        disable_environment = 'DISABLE_IRDASHIES_OPENXR'
    }
}
$json | ConvertTo-Json | Set-Content -Path $jsonDest -Force
Write-Host "Manifest created at $jsonDest"

# Register in OpenXR implicit layers
$regPath = 'HKLM:\SOFTWARE\Khronos\OpenXR\1\ApiLayers\Implicit'
New-Item -Path $regPath -Force | Out-Null
$regName = $jsonDest -replace '\\', '\\'
New-ItemProperty -Path $regPath -Name $regName -Value 0 -PropertyType DWord -Force | Out-Null
Write-Host 'Registry key added.'

Write-Host 'OpenXR layer registered successfully.'
