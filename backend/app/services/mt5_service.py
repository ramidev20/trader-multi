import MetaTrader5 as mt5
from datetime import datetime

SYMBOL = "XAUUSD"
TIMEFRAME = mt5.TIMEFRAME_M1


def initialize_mt5(login, password, server, path):
    try:
        mt5.shutdown()
    except:
        pass

    if not mt5.initialize(path=path):
        return False, mt5.last_error()

    if not mt5.login(login=login, password=password, server=server):
        return False, mt5.last_error()

    return True, "Connected"


def is_logged_in() -> bool:
    # if MT5 terminal is not initialized or not authenticated, this returns None
    return mt5.account_info() is not None

def shutdown():
    mt5.shutdown()


def get_current_price(symbol=SYMBOL):
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return None
    return (tick.bid + tick.ask) / 2





def get_account_info():
    account = mt5.account_info()
    if account is None:
        return None
    return {
        "balance": account.balance,
        "equity": account.equity,
        "profit": account.profit,
        "margin": account.margin,
    }




def get_candles(timeframe_str="M5", limit=1000):
    timeframe_map = {
        "M1": mt5.TIMEFRAME_M1,
        "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15,
        "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1,
        "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1,
    }

    timeframe = timeframe_map.get(timeframe_str, mt5.TIMEFRAME_M5)

    rates = mt5.copy_rates_from_pos(SYMBOL, timeframe, 0, limit)

    if rates is None:
        return []

    candles = []
    for r in rates:
        candles.append({
            "time": int(r["time"]),  # seconds for lightweight-charts
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
        })

    return candles



def open_market_order(order_type, lot, tp, sl):
    tick = mt5.symbol_info_tick(SYMBOL)
    if tick is None:
        return {"error": "Symbol not available"}

    price = tick.ask if order_type == "BUY" else tick.bid

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": SYMBOL,
        "volume": float(lot),
        "type": mt5.ORDER_TYPE_BUY if order_type == "BUY" else mt5.ORDER_TYPE_SELL,
        "price": price,
        "tp": float(tp),
        "sl": float(sl),
        "deviation": 20,
        "magic": 123456,
        "comment": "Web trade",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_FOK,
    }

    result = mt5.order_send(request)
    return result._asdict() if result else {"error": "Order failed"}


def close_all_positions():
    positions = mt5.positions_get()
    if not positions:
        return {"message": "No open positions"}

    closed = 0
    failed = 0

    for p in positions:
        try:
            symbol = p.symbol
            volume = float(p.volume)
            ticket = int(p.ticket)

            # close with opposite order type
            close_type = mt5.ORDER_TYPE_SELL if int(p.type) == int(mt5.POSITION_TYPE_BUY) else mt5.ORDER_TYPE_BUY

            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                failed += 1
                continue

            price = tick.bid if close_type == mt5.ORDER_TYPE_SELL else tick.ask

            req = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "position": ticket,
                "volume": volume,
                "type": close_type,
                "price": float(price),
                "deviation": 20,
                "magic": 123456,
                "comment": "close all positions",
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_FOK,
            }

            result = mt5.order_send(req)
            if result is None:
                failed += 1
                continue

            rdict = result._asdict() if hasattr(result, "_asdict") else {}
            if int(rdict.get("retcode", -1)) in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_DONE_PARTIAL):
                closed += 1
            else:
                failed += 1

        except Exception:
            failed += 1

    return {"message": "Close all complete", "closed": closed, "failed": failed}



from datetime import datetime, timedelta, timezone

def get_open_positions(symbol: str | None = None):
    """
    Returns rows shaped for your React PositionRow:
    {ticket, symbol, type, volume, price_open, profit}
    """
    if not is_logged_in():
        return []

    positions = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
    if positions is None:
        return []

    rows = []
    for p in positions:
        rows.append({
            "ticket": int(p.ticket),
            "time_open": int(p.time), 
            "symbol": p.symbol,
            "type": "BUY" if int(p.type) == int(mt5.POSITION_TYPE_BUY) else "SELL",
            "volume": float(p.volume),
            "price_open": float(p.price_open),
            "profit": float(p.profit),
        })
    return rows


def get_history_deals(days: int = 7, limit: int = 200, symbol: str | None = None):
    if not is_logged_in():
        return []

    now = datetime.now()                       # ✅ naive local time
    date_from = now - timedelta(days=days)
    date_to = now + timedelta(minutes=5)       # ✅ buffer for newest deals

    deals = mt5.history_deals_get(date_from, date_to)
    if deals is None:
        return []

    rows = []
    for d in deals:
        if symbol and d.symbol != symbol:
            continue

        dtype = int(d.type)
        if dtype == int(mt5.DEAL_TYPE_BUY):
            type_str = "BUY"
        elif dtype == int(mt5.DEAL_TYPE_SELL):
            type_str = "SELL"
        else:
            continue  # ✅ keep only real trade deals (optional but helps markers)

        rows.append({
            "ticket": int(d.ticket),
            "time": int(d.time),
            "symbol": d.symbol,
            "type": type_str,
            "price": float(d.price),
            "volume": float(d.volume),
            "profit": float(d.profit),
        })

    rows.sort(key=lambda x: x["time"], reverse=True)
    return rows[: max(1, int(limit))]
