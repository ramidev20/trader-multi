# Lequidity Trader

Lequidity Trader is a React/Vite dashboard with a FastAPI backend for managing cTrader accounts, strategy execution, risk monitoring, and trade history.

This `ctrader` branch trades through the **cTrader Open API**: each account adapter holds a direct TLS connection to cTrader's servers, so no trading terminal has to be installed or running. Prices, candles, positions and fills are pushed to the app and served from memory.

## Development

Install the backend dependencies:

```powershell
pip install -r requirements.txt
```

Start the backend from the project root:

```powershell
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --no-access-log
```

This runs Uvicorn in the foreground without a reload supervisor, so `Ctrl+C`
stops the server and returns control to the same terminal. Add `--reload` only
when automatic backend restarts on code changes are needed; reload mode runs a
separate watcher process.

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

## cTrader Setup

1. Register an application at [openapi.ctrader.com](https://openapi.ctrader.com) and wait for it to be approved.
2. Put its credentials in `ctrader/config.json` (created on first launch):

   ```json
   "ctrader_app": {
       "client_id": "...",
       "client_secret": "..."
   }
   ```

3. In the application's settings on openapi.ctrader.com, add this **Redirect URI**:

   ```
   http://127.0.0.1:8000/ctrader/callback
   ```

   If the backend runs on another port, use that port here and add `"redirect_uri"` with the same value to `ctrader_app` in `ctrader/config.json`.

4. In the app, open **Add Account** and click **Connect with cTrader**. Sign in in the browser with the cTrader ID that owns the trading accounts and approve access. Back in the app, pick the account from the list (it shows each account's balance and whether it is Demo or Real). Name it, set its risk and save. The first account saved becomes the master.

The same application credentials work on every PC and for every person: each user connects with their own cTrader ID and gets their own tokens. Access tokens last about 30 days; for accounts added through **Connect with cTrader** the backend renews them automatically a week before they expire, including on running connections. If renewal fails (for example after access was revoked at id.ctrader.com), the adapter log says so; open the account's settings and click **Reconnect with cTrader**.

Do not connect the same account on two PCs at the same time: each PC would place its own trades on it.

## Configuration

Account and strategy settings are stored in the local `ctrader/config.json` file. It is intentionally ignored by Git because it can contain account credentials.

## Remote Control With Tailscale

Install the standard **Tailscale** desktop app on both PCs and sign in to the same Tailscale account. You do not need to configure an exit node, VPN server, subnet router, Tailscale SSH, or any additional service.

On the trading PC, open **Remote Control**, choose **Receiver**, enable remote trades, generate a long token, and enter `ws://<this-pc-tailscale-ip>:8000/remote/ws`. Save the setup and restart the app once.

On the controller PC, open **Remote Control**, choose **Controller / Trader**, enter the same receiver URL and token, then connect. Tailscale encrypts the private connection between the two PCs. The command channel supports opening market or limit orders, starting or stopping search, and closing all positions. Recent command IDs are retained to make retried commands idempotent.
