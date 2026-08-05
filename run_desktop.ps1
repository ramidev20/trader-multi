$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

Set-Location ".\frontend"

if (-not (Test-Path ".\dist\index.html")) {
  Write-Host "Frontend build not found. Building React frontend..."
  & "$env:ProgramFiles\nodejs\npm.cmd" run build
}

Write-Host "Starting React desktop app with Python backend..."
# VS Code's Code Runner can set this flag, which makes Electron run as plain Node.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
& "$env:ProgramFiles\nodejs\npm.cmd" run desktop
