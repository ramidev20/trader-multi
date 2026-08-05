$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

Write-Host "Building frontend..."
Set-Location ".\frontend"
& "$env:ProgramFiles\nodejs\npm.cmd" run build
Set-Location ".."

Write-Host "React desktop app is ready. Launch it with:"
Write-Host "  .\run_desktop.ps1"
