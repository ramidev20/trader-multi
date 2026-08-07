from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
import threading
from typing import Callable, Optional

LogFn = Callable[[str, str], None]


@dataclass
class ManagedTask:
    name: str
    interval_sec: int
    start_time: datetime
    end_time: Optional[datetime]
    timer: threading.Timer | None = None


tasks: dict[str, ManagedTask] = {}
_tasks_lock = threading.Lock()
_runtime_logger: Optional[LogFn] = None


def _normalize_dt(dt: datetime) -> datetime:
    # Normalize aware datetimes to local naive so all scheduler comparisons are safe.
    if dt.tzinfo is None:
        return dt
    try:
        return dt.astimezone().replace(tzinfo=None)
    except Exception:
        return dt.replace(tzinfo=None)


def set_runtime_logger(logger: Optional[LogFn]) -> None:
    global _runtime_logger
    _runtime_logger = logger


def emit_log(message: str, level: str = "info") -> None:
    if _runtime_logger:
        try:
            _runtime_logger(message, level)
            return
        except Exception:
            pass
    print(message)


def start_task(
    task_name: str,
    func: Callable,
    *args,
    interval_sec: int,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    end_time_enabled: bool = False,
    on_task_start: Callable | None = None,
    on_task_end: Callable | None = None,
    log_schedule: bool = True,
) -> None:
    stop_task(task_name)

    now = _normalize_dt(datetime.now())
    normalized_start = _normalize_dt(start_time) if start_time else None
    normalized_end = _normalize_dt(end_time) if end_time else None
    ref_time = normalized_start if normalized_start and normalized_start > now else now

    def wrapped(next_run_time: datetime) -> None:
        with _tasks_lock:
            task = tasks.get(task_name)
        if not task:
            return

        if end_time_enabled and task.end_time and _normalize_dt(datetime.now()) >= _normalize_dt(task.end_time):
            stop_task(task_name)
            emit_log(f"[{task_name}] task ended at {datetime.now().strftime('%H:%M:%S')}", "warning")
            if on_task_end:
                try:
                    on_task_end()
                except Exception as ex:
                    emit_log(f"[{task_name}] on_task_end error: {ex}", "error")
            return

        try:
            func(*args)
        except Exception as ex:
            emit_log(f"[{task_name}] runtime error: {ex}", "error")

        next_run_time += timedelta(seconds=task.interval_sec)
        delay = max(0, (next_run_time - _normalize_dt(datetime.now())).total_seconds())

        timer = threading.Timer(delay, wrapped, args=(next_run_time,))
        with _tasks_lock:
            t2 = tasks.get(task_name)
            if not t2:
                return
            t2.timer = timer
        timer.start()

    delay = max(0, (ref_time - now).total_seconds())
    first_run_time = now + timedelta(seconds=delay)
    timer = threading.Timer(delay, wrapped, args=(first_run_time,))

    with _tasks_lock:
        tasks[task_name] = ManagedTask(
            name=task_name,
            start_time=ref_time,
            interval_sec=interval_sec,
            end_time=normalized_end,
            timer=timer,
        )

    if on_task_start:
        try:
            on_task_start(*args)
        except Exception as ex:
            emit_log(f"[{task_name}] on_task_start error: {ex}", "error")

    timer.start()


def stop_task(task_name: str) -> None:
    with _tasks_lock:
        task = tasks.get(task_name)
        if not task:
            return
        try:
            if task.timer:
                task.timer.cancel()
        except Exception:
            pass
        tasks.pop(task_name, None)


def stop_all_tasks() -> None:
    with _tasks_lock:
        names = list(tasks.keys())
    for name in names:
        stop_task(name)


def is_task_running(task_name: str) -> bool:
    with _tasks_lock:
        return task_name in tasks
