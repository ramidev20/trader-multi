from __future__ import annotations

import os
import subprocess
from pathlib import Path


def sanitize_terminal_path(path_value: str | None) -> str:
    path = str(path_value or "").strip()
    if len(path) >= 2 and path[0] == path[-1] and path[0] in {'"', "'"}:
        path = path[1:-1].strip()
    return path


def resolve_terminal_path(path_value: str | None) -> str:
    path = sanitize_terminal_path(path_value)
    if not path:
        return ""

    # Windows-style path stored in config while the app runs on Linux/Wine.
    # Convert it into the corresponding path inside the Wine prefix.
    if os.name != "nt" and len(path) > 1 and path[1] == ":" and path[0].isalpha():
        wine_prefix = os.environ.get("WINEPREFIX") or str(Path.home() / ".wine")
        drive_letter = path[0].lower()
        remainder = path[2:].replace("\\", "/").lstrip("/")
        return str(Path(wine_prefix) / f"drive_{drive_letter}" / remainder)

    # If the process is running under Wine on Windows, convert Linux paths to
    # Windows paths before passing them to MT5.
    if os.name == "nt" and path.startswith("/"):
        try:
            converted = subprocess.check_output(["winepath", "-w", path], text=True).strip()
            if converted:
                return converted
        except (OSError, subprocess.CalledProcessError):
            pass

    return path
