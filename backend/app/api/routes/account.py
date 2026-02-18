from fastapi import APIRouter, HTTPException
from app.services.mt5_service import get_account_info

router = APIRouter(tags=["Account"])  # ✅ no prefix here

@router.get("/info")
async def account_info():
    info = get_account_info()
    if info is None:
        raise HTTPException(status_code=401, detail="Not logged in")
    return info
