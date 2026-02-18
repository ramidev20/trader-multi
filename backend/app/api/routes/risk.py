from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.mt5_service import is_logged_in
from app.services.risk_service import risk_service

router = APIRouter()

class RiskStartRequest(BaseModel):
    enabled: bool = True
    symbol: str = "XAUUSD"

    maxDailyLoss: float = 250.0
    maxDrawdown: float = 500.0
    stopAfterProfit: float = 300.0
    maxOpenPositions: int = 2

    disableNewTradesOnLimit: bool = True
    closePositionsOnLimit: bool = False


@router.post("/start")
def start_risk(payload: RiskStartRequest):
    if not is_logged_in():
        raise HTTPException(status_code=401, detail="MT5 account not logged in")

    risk_service.start(payload.dict())
    return {"status": "started"}


@router.post("/stop")
def stop_risk():
    risk_service.stop()
    return {"status": "stopped"}


@router.get("/status")
def status():
    return risk_service.get_status()
