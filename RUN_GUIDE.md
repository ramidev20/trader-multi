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
pip install -r requirements-desktop.txt
.\run_desktop.ps1
```

This builds the React frontend when needed, starts the Python backend automatically, and opens the React app in an Electron desktop window.

## 5) Build the React frontend

```powershell
.\build_desktop.ps1
```

The desktop launcher uses Electron from `frontend/node_modules` and does not use pywebview or Flet.
