from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import asyncio
import MetaTrader5 as mt5

from app.services.mt5_service import initialize_mt5, get_account_info, shutdown

router = APIRouter(tags=["Auth"])  # ✅ no prefix here (main.py already adds /api/auth)

class LoginRequest(BaseModel):
    login: int
    password: str
    server: str
    path: str

@router.post("/login")
async def login(req: LoginRequest):
    print("LOGIN REQUEST RECEIVED")  # ✅ debug line

    try:
        ok, msg = await asyncio.wait_for(
            asyncio.to_thread(
                initialize_mt5,
                req.login,
                req.password,
                req.server,
                req.path,
            ),
            timeout=8.0,
        )
    except asyncio.TimeoutError:
        print("MT5 INIT TIMEOUT")
        raise HTTPException(status_code=504, detail="MT5 initialize timed out")
    except Exception as e:
        print("LOGIN ERROR:", e)
        raise HTTPException(status_code=500, detail=f"Login error: {e}")

    if not ok:
        print("LOGIN FAILED:", msg)
        raise HTTPException(status_code=401, detail=str(msg))

    info = await asyncio.to_thread(get_account_info)
    return {"success": True, "account": info}

@router.post("/logout")
async def logout():
    await asyncio.to_thread(shutdown)
    return {"success": True}
