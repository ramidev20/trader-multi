from pathlib import Path

from fastapi import FastAPI
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import trade, account, chart, auth, strategy, utility, risk
from app.websockets.manager import router as ws_router

app = FastAPI(title="MT5 Trading Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(trade.router, prefix="/api/trade")
app.include_router(account.router, prefix="/api/account")
app.include_router(chart.router, prefix="/api/chart")
app.include_router(auth.router, prefix="/api/auth")
app.include_router(strategy.router, prefix="/api/strategy")  # ✅ ADD THIS

app.include_router(utility.router, prefix="/api/utility")
app.include_router(risk.router, prefix="/api/risk")

app.include_router(ws_router, prefix="/ws")

FRONTEND_DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

if FRONTEND_DIST.exists():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")

    @app.get("/", include_in_schema=False)
    def spa_index():
        return FileResponse(str(FRONTEND_DIST / "index.html"))

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_fallback(full_path: str):
        if full_path.startswith("api/") or full_path.startswith("ws/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = FRONTEND_DIST / full_path
        if candidate.exists() and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(FRONTEND_DIST / "index.html"))
else:
    @app.get("/")
    def health():
        return {"status": "Backend running"}
