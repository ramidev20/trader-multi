from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path

import MetaTrader5 as mt5

from backend.app.services.path_utils import resolve_terminal_path


def write_status(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--login", required=True, type=int)
    parser.add_argument("--password", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--terminal-path", required=True)
    parser.add_argument("--status-file", required=True)
    args = parser.parse_args()
    terminal_path = resolve_terminal_path(args.terminal_path)

    status_file = Path(args.status_file)
    write_status(
        status_file,
        {
            "state": "starting",
            "pid": os.getpid(),
            "login": args.login,
            "server": args.server,
            "terminal_path": terminal_path,
            "updated_at": int(time.time()),
        },
    )

    ok = mt5.initialize(
        login=args.login,
        password=args.password,
        server=args.server,
        path=terminal_path,
    )
    if not ok:
        write_status(
            status_file,
            {
                "state": "error",
                "pid": os.getpid(),
                "login": args.login,
                "server": args.server,
                "terminal_path": terminal_path,
                "error": str(mt5.last_error()),
                "updated_at": int(time.time()),
            },
        )
        return

    try:
        while True:
            terminal = mt5.terminal_info()
            ping_last = float(getattr(terminal, "ping_last", 0.0) or 0.0) if terminal is not None else 0.0
            algo_enabled = bool(getattr(terminal, "trade_allowed", True)) and not bool(getattr(terminal, "tradeapi_disabled", False)) if terminal is not None else None
            info = mt5.account_info()
            if info is None:
                write_status(
                    status_file,
                    {
                        "state": "warning",
                        "pid": os.getpid(),
                        "login": args.login,
                        "server": args.server,
                        "terminal_path": terminal_path,
                        "latency": round(ping_last / 1000.0, 2) if ping_last > 0 else 0.0,
                        "algo_enabled": algo_enabled,
                        "error": "No account info available",
                        "updated_at": int(time.time()),
                    },
                )
            else:
                write_status(
                    status_file,
                    {
                        "state": "connected",
                        "pid": os.getpid(),
                        "login": int(getattr(info, "login", args.login) or args.login),
                        "server": str(getattr(info, "server", args.server) or args.server),
                        "balance": float(getattr(info, "balance", 0.0) or 0.0),
                        "equity": float(getattr(info, "equity", 0.0) or 0.0),
                        "latency": round(ping_last / 1000.0, 2) if ping_last > 0 else 0.0,
                        "algo_enabled": algo_enabled,
                        "terminal_path": terminal_path,
                        "updated_at": int(time.time()),
                    },
                )
            time.sleep(2.0)
    except KeyboardInterrupt:
        pass
    finally:
        mt5.shutdown()
        write_status(
            status_file,
            {
                "state": "stopped",
                "pid": os.getpid(),
                "login": args.login,
                "server": args.server,
                "terminal_path": terminal_path,
                "updated_at": int(time.time()),
            },
        )


if __name__ == "__main__":
    main()
