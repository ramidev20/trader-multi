import argparse
import json
import os
import time
from pathlib import Path

import MetaTrader5 as mt5


def write_status(path: Path, payload: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--login", required=True, type=int)
    parser.add_argument("--password", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--terminal-path", required=True)
    parser.add_argument("--status-file", required=True)
    args = parser.parse_args()

    status_file = Path(args.status_file)
    write_status(
        status_file,
        {
            "state": "starting",
            "pid": os.getpid(),
            "login": args.login,
            "server": args.server,
            "terminal_path": args.terminal_path,
            "updated_at": int(time.time()),
        },
    )

    ok = mt5.initialize(
        login=args.login,
        password=args.password,
        server=args.server,
        path=args.terminal_path,
    )
    if not ok:
        write_status(
            status_file,
            {
                "state": "error",
                "pid": os.getpid(),
                "login": args.login,
                "server": args.server,
                "terminal_path": args.terminal_path,
                "error": str(mt5.last_error()),
                "updated_at": int(time.time()),
            },
        )
        return

    try:
        while True:
            info = mt5.account_info()
            if info is None:
                write_status(
                    status_file,
                    {
                        "state": "warning",
                        "pid": os.getpid(),
                        "login": args.login,
                        "server": args.server,
                        "terminal_path": args.terminal_path,
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
                        "terminal_path": args.terminal_path,
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
                    "terminal_path": args.terminal_path,
                    "updated_at": int(time.time()),
                },
            )


if __name__ == "__main__":
    main()
