import os
from dotenv import load_dotenv

load_dotenv()

class Settings:
    PROJECT_NAME = "Trading System"
    MT5_SYMBOL = os.getenv("MT5_SYMBOL", "XAUUSD")
    SECRET_KEY = os.getenv("SECRET_KEY", "supersecret")

settings = Settings()
