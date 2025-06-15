from abc import ABC, abstractmethod
from typing import Optional


class Notifier(ABC):
    """Base class for sending notifications."""
    
    @abstractmethod
    def send(self, text: str) -> Optional[str]:
        """Send a text notification.
        
        Args:
            text: The message text to send
            
        Returns:
            Message ID if successful, None otherwise
        """
        pass