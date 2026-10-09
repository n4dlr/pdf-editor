$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if ($env:OS -ne 'Windows_NT') {
    throw 'This start script is for Windows only.'
}

foreach ($command in @('node', 'npm', 'cargo')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $command. Run .\setup-windows.ps1 first, then reopen this terminal."
    }
}

if (-not (Test-Path (Join-Path $projectRoot 'node_modules'))) {
    throw 'Frontend dependencies are missing. Run .\setup-windows.ps1 first.'
}

npm run tauri -- dev
if ($LASTEXITCODE -ne 0) {
    throw "Tauri exited with code $LASTEXITCODE"
}
