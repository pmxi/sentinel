import os
from pathlib import Path

# Load environment variables from .env file if it exists
try:
    from dotenv import load_dotenv

    # Look for .env file in the project root
    env_path = Path(__file__).parent.parent / ".env"
    load_dotenv(env_path)
except ImportError:
    # python-dotenv not installed, environment variables must be set manually
    pass


class Settings:
    """Configuration settings for the application"""

    # Gmail API settings
    GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
    GMAIL_CREDENTIALS_FILE = os.path.join(
        os.path.dirname(__file__), "..", "credentials.json"
    )
    GMAIL_TOKEN_FILE = os.path.join(os.path.dirname(__file__), "..", "token.json")

    # LLM Configuration
    LLM_PROVIDER = os.getenv(
        "LLM_PROVIDER", "google"
    )  # google, openai, anthropic, local
    LLM_API_KEY = os.getenv("LLM_API_KEY")
    LLM_MODEL = os.getenv("LLM_MODEL", "gemini-2.5-flash-preview-05-20")

    # Twilio settings
    TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID")
    TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN")
    TWILIO_PHONE_NUMBER = os.getenv("TWILIO_PHONE_NUMBER")
    NOTIFICATION_PHONE_NUMBER = os.getenv("NOTIFICATION_PHONE_NUMBER")
    
    # Telegram settings
    TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
    TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
    
    # Purdue email settings
    PURDUE_EMAIL = os.getenv("PURDUE_EMAIL")
    PURDUE_IMAP_SERVER = os.getenv("PURDUE_IMAP_SERVER", "outlook.office365.com")
    PURDUE_IMAP_PORT = int(os.getenv("PURDUE_IMAP_PORT", "993"))
    
    # Microsoft OAuth settings for Purdue
    PURDUE_CLIENT_ID = os.getenv("PURDUE_CLIENT_ID")
    PURDUE_CLIENT_SECRET = os.getenv("PURDUE_CLIENT_SECRET")  # Optional for public client
    PURDUE_TENANT_ID = os.getenv("PURDUE_TENANT_ID", "common")
    
    # Monitoring settings
    POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "30"))
    PROCESS_ONLY_UNREAD = os.getenv("PROCESS_ONLY_UNREAD", "true").lower() == "true"
    MAX_LOOKBACK_HOURS = int(os.getenv("MAX_LOOKBACK_HOURS", "24"))
    DATABASE_PATH = os.getenv("DATABASE_PATH", "sentinel.db")
    
    # Logging settings
    LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")  # DEBUG, INFO, WARNING, ERROR, CRITICAL
    LOG_DIR = os.getenv("LOG_DIR", "logs")
    DISABLE_FILE_LOGGING = os.getenv("DISABLE_FILE_LOGGING", "false").lower() == "true"

    @classmethod
    def validate(cls):
        """Validate that required configuration is present"""
        if not cls.LLM_API_KEY:
            raise ValueError("LLM_API_KEY environment variable is required")
        return True


settings = Settings()
