@echo off
setlocal EnableExtensions

set "RUNNER_DIR=%~dp0"
for %%I in ("%RUNNER_DIR%..") do set "PROJECT_ROOT=%%~fI"
set "VENV_DIR=%RUNNER_DIR%.venv"

if not exist "%PROJECT_ROOT%\backend" (
  echo Could not find project root from runner folder.
  pause
  exit /b 1
)

set "ENV_FILE=%RUNNER_DIR%.env"
if exist "%ENV_FILE%" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ENV_FILE%") do (
    if not "%%A"=="" (
      set "%%A=%%B"
    )
  )
)

if "%APP_HOST%"=="" set "APP_HOST=127.0.0.1"
if "%APP_PORT%"=="" set "APP_PORT=8000"
if "%AUTO_OPEN_BROWSER%"=="" set "AUTO_OPEN_BROWSER=1"

echo [1/4] Preparing Python environment...
cd /d "%PROJECT_ROOT%"

if not exist "%VENV_DIR%\Scripts\python.exe" (
  where py >nul 2>nul
  if errorlevel 1 (
    python -m venv "%VENV_DIR%"
  ) else (
    py -3 -m venv "%VENV_DIR%"
  )
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
  echo Failed to create Python virtual environment.
  pause
  exit /b 1
)

set "PY=%VENV_DIR%\Scripts\python.exe"

echo [2/4] Installing backend dependencies...
"%PY%" -m pip install --disable-pip-version-check -q -r backend\requirements.txt
if errorlevel 1 (
  echo Failed to install backend dependencies.
  pause
  exit /b 1
)

if not exist "frontend\dist\index.html" (
  echo [3/4] Frontend build not found. Building frontend...
  where npm >nul 2>nul
  if errorlevel 1 (
    echo Node.js/npm is required to build frontend for the first time.
    pause
    exit /b 1
  )

  pushd frontend
  call npm install
  if errorlevel 1 (
    popd
    echo npm install failed.
    pause
    exit /b 1
  )

  call npm run build
  if errorlevel 1 (
    popd
    echo npm run build failed.
    pause
    exit /b 1
  )
  popd
)

echo [4/4] Starting app on http://%APP_HOST%:%APP_PORT%
if "%AUTO_OPEN_BROWSER%"=="1" start "" "http://%APP_HOST%:%APP_PORT%"

pushd backend
"%PY%" -m uvicorn app.main:app --host %APP_HOST% --port %APP_PORT%
popd

endlocal
