from abc import ABC, abstractmethod
from typing import Optional

from src.classifier.email_classifier import ClassificationResult
from src.email.gmail.models import EmailData


class EmailNotifier(ABC):
    """Base class for email-specific notifications."""
    
    @abstractmethod
    def notify(self, email: EmailData, classification: ClassificationResult) -> Optional[str]:
        """Format and send a notification about an email.
        
        Args:
            email: The email data
            classification: The classification result
            
        Returns:
            Message ID if successful, None otherwise
        """
        pass