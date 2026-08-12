# Lequidity Trader

Lequidity Trader is a React/Vite dashboard with a FastAPI backend for managing MetaTrader 5 accounts, strategy execution, risk monitoring, and trade history.

## Development

Install the backend dependencies:

```powershell
pip install -r requirements.txt
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
pip install -r requirements.txt
python run.py
```

The launcher starts the FastAPI backend and Vite development server, then opens the React dashboard in a Python `pywebview` desktop window. Saved frontend changes hot-reload in the window; no `frontend/dist` build is used by `python run.py`.

## Developer Mode

The root `.env` file controls developer mode. With `TRADER_DEV_MODE=true` and `VITE_DEV_MODE=true`, the app uses mock MT5 data so you can browse and test pages without logging into a live MT5 account.

## Configuration

Account and strategy settings are stored in the local `config.json` file. It is intentionally ignored by Git because it can contain account credentials.

## Remote Control With Tailscale

On the trading PC, install and sign in to Tailscale, set a long `TRADER_REMOTE_TOKEN` in `.env`, set `TRADER_DEV_MODE=false`, `DEV_MODE=false`, and `TRADER_REMOTE_ENABLED=true` so commands reach live MT5 and the receiver is exposed to Tailscale. Then launch normally:

```powershell
python run.py
```

On the controller PC, open **Remote Control**, enter `ws://<trading-pc-tailscale-ip>:8000/remote/ws` and the same token, then connect. The token is sent in the initial WebSocket message rather than the URL. The command channel supports opening market or limit orders, starting/stopping search, and closing all positions. It only accepts authenticated WebSocket connections and stores recent command IDs to make retried commands idempotent.
