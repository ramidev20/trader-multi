# Lequidity Trader

Lequidity Trader is a React/Vite dashboard with a FastAPI backend for managing MetaTrader 5 accounts, strategy execution, risk monitoring, and trade history.

## Development

Install the backend dependencies:

```powershell
pip install -r backend/requirements.txt
```

Start the backend from the project root:

```powershell
uvicorn backend.app.main:app --reload --host 127.0.0.1 --port 8000
```

In a second terminal, install and start the frontend:

```powershell
cd frontend
npm install
npm run dev
```

The development dashboard is available at `http://localhost:5173`.

## Desktop mode

Install the desktop dependencies and launch the single-window app from the project root:

```powershell
pip install -r requirements-desktop.txt
.\run_desktop.ps1
```

The launcher builds `frontend/dist` when needed, starts the Python FastAPI backend, and opens the React dashboard in an Electron desktop window. The old Flet and pywebview launchers have been removed.

## Windows executable

```powershell
.\build_desktop.ps1
```

The packaged executable is written to `dist\LequidityTraderDesktop\`.

## Configuration

Account and strategy settings are stored in the local `config.json` file. It is intentionally ignored by Git because it can contain account credentials.
