$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if ($env:OS -ne 'Windows_NT') {
    throw 'Run this script on Windows. Tauri Windows installers must be built on Windows.'
}

foreach ($command in @('rustc', 'cargo')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required build tool not found: $command. Install Node.js LTS and Rust with the MSVC toolchain."
    }
}

Write-Host 'Building the native Windows executable...'
cargo build --release --manifest-path .\native\Cargo.toml
if ($LASTEXITCODE -ne 0) {
    throw "Native Windows build failed with exit code $LASTEXITCODE"
}

$exe = Join-Path $projectRoot 'native\target\release\super-pdf-studio.exe'
if (-not (Test-Path $exe)) {
    throw "Cargo completed without producing $exe"
}

$outputDir = Join-Path $projectRoot 'artifacts'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$outputPath = Join-Path $outputDir 'SuperPDFStudio.exe'
Copy-Item -Path $exe -Destination $outputPath -Force

Write-Host "Windows executable created: $outputPath"
