from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import MetaTrader5 as mt5

from app.services.mt5_service import is_logged_in, close_all_positions

router = APIRouter()

class SymbolReq(BaseModel):
    symbol: str

class SideReq(BaseModel):
    side: str  # "BUY" or "SELL"

@router.post("/close-all")
def close_all():
    if not is_logged_in():
        raise HTTPException(status_code=401, detail="MT5 account not logged in")
    return close_all_positions()

@router.post("/close-symbol")
def close_symbol(payload: SymbolReq):
    if not is_logged_in():
        raise HTTPException(status_code=401, detail="MT5 account not logged in")

    sym = payload.symbol.strip()
    positions = mt5.positions_get(symbol=sym) or []
    for p in positions:
        close_type = mt5.ORDER_TYPE_SELL if int(p.type) == int(mt5.POSITION_TYPE_BUY) else mt5.ORDER_TYPE_BUY
        tick = mt5.symbol_info_tick(p.symbol)
        if not tick:
            continue
        price = tick.bid if close_type == mt5.ORDER_TYPE_SELL else tick.ask

        req = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": p.symbol,
            "position": int(p.ticket),
            "volume": float(p.volume),
            "type": close_type,
            "price": float(price),
            "deviation": 20,
            "magic": 777,
            "comment": "utility close symbol",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_FOK,
        }
        mt5.order_send(req)

    return {"ok": True, "symbol": sym}

@router.post("/close-side")
def close_side(payload: SideReq):
    if not is_logged_in():
        raise HTTPException(status_code=401, detail="MT5 account not logged in")

    side = payload.side.upper().strip()
    if side not in ("BUY", "SELL"):
        raise HTTPException(status_code=400, detail="side must be BUY or SELL")

    positions = mt5.positions_get() or []
    for p in positions:
        p_side = "BUY" if int(p.type) == int(mt5.POSITION_TYPE_BUY) else "SELL"
        if p_side != side:
            continue

        close_type = mt5.ORDER_TYPE_SELL if p_side == "BUY" else mt5.ORDER_TYPE_BUY
        tick = mt5.symbol_info_tick(p.symbol)
        if not tick:
            continue
        price = tick.bid if close_type == mt5.ORDER_TYPE_SELL else tick.ask

        req = {
            "action": mt5.TRADE_ACTION_DEAL,
            "symbol": p.symbol,
            "position": int(p.ticket),
            "volume": float(p.volume),
            "type": close_type,
            "price": float(price),
            "deviation": 20,
            "magic": 777,
            "comment": "utility close side",
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_FOK,
        }
        mt5.order_send(req)

    return {"ok": True, "side": side}

@router.post("/flatten")
def flatten():
    if not is_logged_in():
        raise HTTPException(status_code=401, detail="MT5 account not logged in")

    # cancel pending orders
    orders = mt5.orders_get() or []
    for o in orders:
        req = {
            "action": mt5.TRADE_ACTION_REMOVE,
            "order": int(o.ticket),
            "symbol": o.symbol,
            "magic": 777,
            "comment": "utility flatten remove order",
        }
        mt5.order_send(req)

    # close positions
    close_all_positions()

    return {"ok": True}
