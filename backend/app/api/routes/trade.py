from fastapi import APIRouter, Query, HTTPException
from pydantic import BaseModel
from typing import Optional

from app.services.mt5_service import (
    is_logged_in,
    open_market_order,
    close_all_positions,
    get_open_positions,
    get_history_deals,
    get_current_price,
)
from app.services.risk_service import risk_service

router = APIRouter()

class TradeRequest(BaseModel):
    type: str  # "BUY" | "SELL"
    lot: float
    tp: float  # pips
    sl: float  # pips


@router.post("/open")
def open_trade(req: TradeRequest):
    if not is_logged_in():
        raise HTTPException(status_code=401, detail="MT5 account not logged in")

    status = risk_service.get_status()
    if status.get("limit_hit") and status.get("config", {}).get("disableNewTradesOnLimit", True):
        raise HTTPException(status_code=403, detail=f"Risk limit hit: {status.get('reason') or 'blocked'}")

    order_type = str(req.type).upper().strip()
    if order_type not in ("BUY", "SELL"):
        raise HTTPException(status_code=400, detail="type must be BUY or SELL")

    price = get_current_price()
    if price is None:
        raise HTTPException(status_code=503, detail="Price not available")

    tp_price = price + req.tp / 10 if order_type == "BUY" else price - req.tp / 10
    sl_price = price - req.sl / 10 if order_type == "BUY" else price + req.sl / 10

    result = open_market_order(order_type, req.lot, tp_price, sl_price)
    return {"result": result}


@router.post("/close-trades")
def close_trades():
    if not is_logged_in():
        raise HTTPException(status_code=401, detail="MT5 account not logged in")
    return close_all_positions()


@router.get("/positions")
def positions(symbol: Optional[str] = None):
    return get_open_positions(symbol=symbol)


@router.get("/history")
def history(
    days: int = Query(7, ge=1, le=365),
    limit: int = Query(200, ge=1, le=5000),
    symbol: Optional[str] = None,
):
    return get_history_deals(days=days, limit=limit, symbol=symbol)
