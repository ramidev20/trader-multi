from fastapi import APIRouter, WebSocket, WebSocketDisconnect
import asyncio
import MetaTrader5 as mt5

from app.services.mt5_service import (
    is_logged_in,
    get_open_positions,
    get_account_info,
    get_history_deals,
)
from app.services.strategy_service import strategy_service

router = APIRouter()

# One lock to prevent concurrent MT5 calls (VERY important)
mt5_lock = asyncio.Lock()

@router.websocket("/live")
async def live_feed(ws: WebSocket):
    await ws.accept()
    print("WebSocket connected")

    last_history_signature = None
    last_positions_signature = None
    last_liquidity_signature = None

    try:
        while True:
            if not is_logged_in():
                await ws.send_json({"type": "status", "connected": False})
                await asyncio.sleep(1)
                continue

            # ---- TICK (fast) ----
            async with mt5_lock:
                tick = mt5.symbol_info_tick("XAUUSD")
            if tick:
                await ws.send_json({
                    "type": "tick",
                    "bid": tick.bid,
                    "ask": tick.ask,
                    "time": tick.time,
                })

            # ---- POSITIONS (send only if changed) ----
            async with mt5_lock:
                positions = get_open_positions()
            pos_sig = tuple(
                (p.get("ticket"), p.get("type"), p.get("volume"), p.get("price_open"))
                for p in (positions or [])
            )
            if pos_sig != last_positions_signature:
                await ws.send_json({"type": "positions", "data": positions})
                last_positions_signature = pos_sig

            # ---- ACCOUNT (can be frequent but small) ----
            async with mt5_lock:
                account = get_account_info()
            await ws.send_json({"type": "account", "data": account})
            await ws.send_json({"type": "status", "connected": True})

            # ---- LIQUIDITY (send only if changed) ----
            liquidity = strategy_service.get_liquidity()
            liq_sig = tuple(
                (l.get("id"), l.get("price"), l.get("side"), l.get("triggered"))
                for l in (liquidity or [])
            )
            if liq_sig != last_liquidity_signature:
                await ws.send_json({"type": "liquidity", "data": liquidity})
                last_liquidity_signature = liq_sig

            # ---- HISTORY (send only if changed) ----
            async with mt5_lock:
                history = get_history_deals(days=7, limit=200)

            hist_sig = None
            if history:
                first = history[0]
                hist_sig = (first.get("ticket"), first.get("time"), first.get("profit"))

            if hist_sig != last_history_signature:
                await ws.send_json({"type": "history", "data": history})
                last_history_signature = hist_sig

            await asyncio.sleep(0.5)  # loop speed (NOT “API calls” anymore)

    except WebSocketDisconnect:
        print("Client disconnected normally")
    except Exception as e:
        print("WebSocket error:", e)
    finally:
        print("WebSocket closed cleanly")

