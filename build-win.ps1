$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if ($env:OS -ne 'Windows_NT') {
    throw 'Run this script on Windows. Tauri Windows installers must be built on Windows.'
}

foreach ($command in @('node', 'npm', 'rustc', 'cargo')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required build tool not found: $command. Install Node.js LTS and Rust with the MSVC toolchain."
    }
}

Write-Host 'Installing locked frontend dependencies...'
npm ci
if ($LASTEXITCODE -ne 0) {
    throw "npm ci failed with exit code $LASTEXITCODE"
}

Write-Host 'Building the Windows NSIS installer...'
npx tauri build --bundles nsis
if ($LASTEXITCODE -ne 0) {
    throw "Tauri build failed with exit code $LASTEXITCODE"
}

$bundleDir = Join-Path $projectRoot 'src-tauri\target\release\bundle\nsis'
$installer = Get-ChildItem -Path $bundleDir -Filter '*-setup.exe' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installer) {
    throw "Tauri completed without producing an NSIS setup in $bundleDir"
}

$outputDir = Join-Path $projectRoot 'artifacts'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$outputPath = Join-Path $outputDir 'SuperPDFStudio_Setup.exe'
Copy-Item -Path $installer.FullName -Destination $outputPath -Force

Write-Host "Setup created: $outputPath"
