param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PdfPath
)
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

if ($env:OS -ne 'Windows_NT') {
    throw 'This start script is for Windows only.'
}

foreach ($command in @('cargo')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $command. Run .\setup-windows.ps1 first, then reopen this terminal."
    }
}

if ($PdfPath.Count -gt 0) {
    cargo run --manifest-path .\native\Cargo.toml -- $PdfPath
} else {
    cargo run --manifest-path .\native\Cargo.toml
}
if ($LASTEXITCODE -ne 0) {
    throw "Native app exited with code $LASTEXITCODE"
}
