from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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

@app.get("/")
def health():
    return {"status": "Backend running"}
