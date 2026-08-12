# Run Guide (Backend + Frontend)

## Prerequisites
- Python 3.10+ (recommended 3.11/3.12)
- Node.js 18+ and npm

## 1) Run Backend (FastAPI)

From project root:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Backend URL:
- `http://127.0.0.1:8000`
- Swagger docs: `http://127.0.0.1:8000/docs`

## 2) Run Frontend (React + Vite)

Open a second terminal, then:

```powershell
cd frontend
npm install
npm run dev
```

Frontend URL:
- `http://localhost:5173`

## 3) Production Build (Frontend)

```powershell
cd frontend
npm run build
npm run preview
```

Preview URL:
- `http://localhost:4173`

## Notes
- Keep backend and frontend running in separate terminals.
- If PowerShell blocks script activation, run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

## 4) Launch As React Desktop App (Single Window)

From project root:

```powershell
pip install -r requirements.txt
python run.py
```

This starts the Python backend and Vite development server automatically, then opens the React app in a Python `pywebview` desktop window. Saved frontend changes hot-reload immediately; it does not use `frontend/dist`.

The desktop launcher now uses Python `pywebview` instead of Electron, so the same launcher flow works across Windows and Linux.

## 5) Developer Mode

The project reads the root `.env` file for both backend and frontend dev flags.

Use these flags in `.env`:
- `TRADER_DEV_MODE=true`
- `VITE_DEV_MODE=true`

With developer mode enabled, the UI loads mock trading data and simulated MT5 behavior so you can test pages without connecting a real MT5 account.

## 6) Remote Control (Two PCs)

On the PC running MT5, install Tailscale and set `TRADER_REMOTE_TOKEN` to a long secret in `.env`. For live commands, set `TRADER_DEV_MODE=false`, `DEV_MODE=false`, and `TRADER_REMOTE_ENABLED=true`, then launch with `python run.py`. Use the **Remote Control** page from the other PC to connect to `ws://<tailscale-ip>:8000/remote/ws` with the same token.
