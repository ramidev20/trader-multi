from fastapi import APIRouter, HTTPException
from app.services.strategy_service import strategy_service
from pydantic import BaseModel
from typing import Optional
from app.services.mt5_service import is_logged_in 

router = APIRouter(tags=["Strategy"])




# ----------- Schemas -----------

class StartStrategyRequest(BaseModel):
    symbol: str
    timeframe: int
    lot: float
    min_pips: float
    max_pips: float
    order_delay: float
    tp_type: bool
    tp: float
    sl_type: bool
    sl: float
    enable_buy: bool = True
    enable_sell: bool = True
    max_orders: int = 1
    start_time: Optional[str] = None
    end_time_enabled: bool = False
    end_time: Optional[str] = None
    use_liquidity: bool = True


class LiquidityCreate(BaseModel):
    price: float
    side: str  # "buy" or "sell"


class LiquidityUpdate(BaseModel):
    price: float


# ----------- Strategy Control -----------

@router.post("/start")
async def start_strategy(payload: StartStrategyRequest):
    if not is_logged_in():
        raise HTTPException(status_code=401, detail="MT5 account not logged in")

    strategy_service.start(payload.dict())
    return {"status": "started"}


@router.post("/stop")
async def stop_strategy():
    strategy_service.stop()
    return {"status": "stopped"}


@router.get("/status")
async def strategy_status():
    return strategy_service.get_status()


# ----------- Liquidity Management -----------

@router.get("/liquidity")
async def get_liquidity():
    return strategy_service.get_liquidity()


@router.post("/liquidity")
async def add_liquidity(payload: LiquidityCreate):
    return strategy_service.add_liquidity(payload.price, payload.side)


@router.patch("/liquidity/{liq_id}")
async def update_liquidity(liq_id: str, payload: LiquidityUpdate):
    return strategy_service.update_liquidity(liq_id, payload.price)


@router.delete("/liquidity/{liq_id}")
async def delete_liquidity(liq_id: str):
    strategy_service.delete_liquidity(liq_id)
    return {"status": "deleted"}
