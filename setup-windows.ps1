$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if ($env:OS -ne 'Windows_NT') {
    throw 'This setup script is for Windows only.'
}

$winget = Get-Command winget -ErrorAction SilentlyContinue
if (-not $winget) {
    throw 'Install App Installer (winget) from Microsoft Store, then rerun this script.'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget could not install Node.js (exit code $LASTEXITCODE)." }
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    winget install --id Rustlang.Rustup --exact --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget could not install Rustup (exit code $LASTEXITCODE)." }
}

if (-not (Get-Command cl -ErrorAction SilentlyContinue)) {
    winget install --id Microsoft.VisualStudio.2022.BuildTools --exact `
        --accept-package-agreements --accept-source-agreements `
        --override '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
    if ($LASTEXITCODE -ne 0) { throw "winget could not install Visual Studio C++ Build Tools (exit code $LASTEXITCODE)." }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
    -not (Get-Command cargo -ErrorAction SilentlyContinue) -or
    -not (Get-Command cl -ErrorAction SilentlyContinue)) {
    Write-Host 'Tool installation completed or is pending. Close this terminal, open a Visual Studio Developer PowerShell, and rerun .\setup-windows.ps1.'
    exit 0
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required; found $(node --version)."
}

rustup toolchain install stable
if ($LASTEXITCODE -ne 0) { throw "rustup could not install the stable toolchain (exit code $LASTEXITCODE)." }
rustup default stable
if ($LASTEXITCODE -ne 0) { throw "rustup could not select the stable toolchain (exit code $LASTEXITCODE)." }
rustup target add x86_64-pc-windows-msvc
if ($LASTEXITCODE -ne 0) { throw "rustup could not add the MSVC target (exit code $LASTEXITCODE)." }
npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit code $LASTEXITCODE)." }
npm run check
if ($LASTEXITCODE -ne 0) { throw "npm run check failed (exit code $LASTEXITCODE)." }

Write-Host 'Windows dependencies are ready.'
Write-Host 'Run .\start-windows.ps1 to start the Tauri desktop app, or npm run dev for browser development.'
