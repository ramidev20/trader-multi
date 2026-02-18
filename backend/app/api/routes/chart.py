from fastapi import APIRouter, Query
from app.services.mt5_service import get_candles

router = APIRouter()

@router.get("/")
def chart_data(timeframe: str = Query("M5")):
    return {"candles": get_candles(timeframe)}
