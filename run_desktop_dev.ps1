$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$frontendDir = Join-Path $PSScriptRoot "frontend"
$npm = Join-Path $env:ProgramFiles "nodejs\npm.cmd"
$viteUrl = "http://127.0.0.1:5173/"

if (-not (Test-Path $npm)) {
  throw "npm.cmd was not found at $npm"
}

Write-Host "Starting Vite dev server..."
$viteProcess = Start-Process `
  -FilePath $npm `
  -ArgumentList "run", "dev", "--", "--host", "127.0.0.1" `
  -WorkingDirectory $frontendDir `
  -WindowStyle Hidden `
  -PassThru

try {
  $deadline = (Get-Date).AddSeconds(30)
  $ready = $false

  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $viteUrl -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        $ready = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }

  if (-not $ready) {
    throw "Vite dev server did not become ready at $viteUrl"
  }

  Write-Host "Starting Electron against Vite dev server..."
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $env:FRONTEND_URL = $viteUrl
  Push-Location $frontendDir
  try {
    & $npm run desktop
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item Env:FRONTEND_URL -ErrorAction SilentlyContinue
  if ($viteProcess -and -not $viteProcess.HasExited) {
    Stop-Process -Id $viteProcess.Id -Force
  }
}
