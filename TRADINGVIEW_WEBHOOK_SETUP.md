# TradingView Webhook Setup

You do not need a custom indicator just to make the webhook work.

TradingView webhooks only fire when an alert is triggered, so you have two options:

1. Use a normal alert on the `OANDA:XAUUSD` chart.
2. Use a small Pine Script indicator if you want a cleaner custom alert workflow.

## Easiest Setup

If you only want to send the latest OANDA XAUUSD price into this app:

1. Open the `OANDA:XAUUSD` chart in TradingView.
2. Create an alert.
3. Put your backend webhook URL in the alert's webhook field:

```text
http://<your-backend-host>:8000/webhooks/tradingview/price
```

4. Use this alert message:

```json
{"symbol":"XAUUSD","source":"OANDA","price":"{{close}}"}
```

When the alert fires, the backend will store the TradingView OANDA price and compare it with the MT5 quote for the new `Precise Spread` card on the Trade page.

## When You Need a Pine Script

You only need a Pine Script indicator if:

- You want custom alert conditions
- You want alerts to fire on a specific strategy or signal
- You want a dedicated reusable alert source on the chart

If you just want a price payload from TradingView, a normal alert can be enough.

## Optional Pine Script Example

Use this if you want a simple alert source on the chart:

```pine
//@version=5
indicator("XAUUSD OANDA Webhook", overlay=true)

trigger = barstate.isconfirmed
alertcondition(trigger, title="Send XAUUSD Price", message='{"symbol":"XAUUSD","source":"OANDA","price":"{{close}}"}')

plot(close, title="Close", color=color.gold)
```

## Optional Webhook Token

If you set `TRADINGVIEW_WEBHOOK_TOKEN` on the backend, include the token in the alert message:

```json
{"symbol":"XAUUSD","source":"OANDA","price":"{{close}}","token":"YOUR_TOKEN"}
```

## Notes

- The app endpoint is `POST /webhooks/tradingview/price`
- The Trade page reads computed comparison data from `GET /precise-spread`
- The comparison uses:
  - `buy_delta = MT5 ask - OANDA price`
  - `sell_delta = OANDA price - MT5 bid`
  - `mid_gap = MT5 mid - OANDA price`
  - `mt5_spread = MT5 ask - MT5 bid`
