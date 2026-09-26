"""pytest-dotmock: point tests at a hosted DotMock LLM mock and assert which fixtures answered."""

from .client import DEFAULT_API_URL, SESSION_HEADER, Dotmock, DotmockError

__all__ = ["DEFAULT_API_URL", "SESSION_HEADER", "Dotmock", "DotmockError"]
__version__ = "0.2.0"
