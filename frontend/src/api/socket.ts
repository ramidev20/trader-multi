import { useTradingStore } from "../store/tradingStore";

let ws: WebSocket | null = null;

export function connectSocket() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
  )
    return;

  ws = new WebSocket("ws://localhost:8000/ws/live");

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const store = useTradingStore.getState();

    switch (msg.type) {
      case "tick":
        store.setLiveData(msg);
        break;
      case "positions":
        store.setPositions(msg.data ?? []);
        break;
      case "history":
        store.setHistory(msg.data ?? []);
        break;
      case "account":
        store.setAccount(msg.data ?? null);
        break;
      case "liquidity":
        store.setLiquidity(msg.data ?? []);
        break;
      case "status":
        // optional: store.setLoggedIn(msg.connected)
        break;
    }
  };

  ws.onclose = () => {
    ws = null;
    // optional reconnect logic
    setTimeout(connectSocket, 1000);
  };

  ws.onerror = () => ws?.close();
}

export function disconnectSocket() {
  ws?.close();
  ws = null;
}
