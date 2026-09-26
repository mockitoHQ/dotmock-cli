"""pytest-dotmock: run DotMock locally in tests and assert which fixtures answered."""

from .server import DEFAULT_IMAGE, DotmockError, DotmockServer

__all__ = ["DEFAULT_IMAGE", "DotmockError", "DotmockServer"]
__version__ = "0.1.0"
