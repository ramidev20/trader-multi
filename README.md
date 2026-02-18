Liquidity Trader

Liquidity Trader is an automated trading system built on MetaTrader 5 (MT5) that executes trades based on liquidity sweeps and candle confirmation logic.

The system includes real-time monitoring via WebSocket and TradingView Lightweight Charts integration for live visualization.

🚀 Features

✅ Liquidity sweep detection (buy-side & sell-side)

✅ Persistent liquidity levels (no timeout expiration)

✅ Candle body size validation (min/max pips)

✅ Volume confirmation logic

✅ Forced trade direction based on liquidity event

✅ Automatic Take Profit / Stop Loss

TP/SL in pips

OR TP/SL in absolute price

✅ Real-time WebSocket data stream

✅ Live open positions monitoring

✅ Trade history tracking

✅ MT5 connection status monitoring

✅ Thread-safe MT5 execution (async lock protected)

🏗️ System Architecture
Frontend (TradingView Chart)
        ↓ WebSocket
FastAPI Backend
        ↓
Strategy Service
        ↓
MetaTrader 5 API

Core Components
🔹 Strategy Service

Detects liquidity sweeps

Stores pending liquidity levels

Waits for valid confirmation candle

Executes trades with configured risk parameters

🔹 WebSocket Manager

Streams live positions

Sends account updates

Sends trade history updates

Monitors MT5 connection status

🔹 MT5 Service

Handles login

Sends orders

Retrieves open positions

Retrieves historical deals

📊 Strategy Logic

Detect liquidity sweep (buy-side or sell-side).

Store liquidity level as pending (no expiration).

Wait for a confirmation candle:

Body size within configured min/max pips

Valid volume conditions

Open trade in forced direction.

Apply TP and SL (pips or absolute price).

Liquidity level remains active until:

A valid trade is executed
OR

A new liquidity event replaces it

⚙️ Configuration Example
config = {
    "symbol": "XAUUSD",
    "min_pips": 10,
    "max_pips": 100,
    "lot": 0.1,
    "tp_type": True,   # True = TP in pips, False = absolute price
    "tp": 200,
    "sl_type": True,   # True = SL in pips, False = absolute price
    "sl": 100,
    "order_delay": 1,
}

🔌 WebSocket Endpoint
/live


Streams:

MT5 connection status

Open positions

Account info

Trade history updates

🛠️ Tech Stack

Python

FastAPI

MetaTrader5 Python API

Asyncio

WebSocket

TradingView Lightweight Charts

📦 Installation
1️⃣ Clone Repository
git clone https://github.com/your-username/liquidity-trader.git
cd liquidity-trader

2️⃣ Install Dependencies
pip install -r requirements.txt

3️⃣ Install & Configure MetaTrader 5

Install MT5 Terminal

Login to your trading account

Enable algorithmic trading

Ensure MT5 terminal is running

▶️ Run Backend
uvicorn app.main:app --reload

📈 Future Improvements

Multi-strategy support

Multi-symbol trading

Risk management module

Backtesting engine

Strategy optimization module

Dashboard UI

⚠️ Risk Disclaimer

This software is for educational and research purposes only.

Trading financial markets involves substantial risk and may result in financial loss. Use at your own risk.
