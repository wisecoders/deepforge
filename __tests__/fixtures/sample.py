"""A simple event system for demonstration."""

import os
from pathlib import Path
from typing import Optional, List

class EventHandler:
    """Interface for handling events."""

    def handle(self, event) -> None:
        raise NotImplementedError


class BaseEmitter:
    """Base class for all event emitters."""

    name: str = "default"

    def __init__(self, max_listeners: int = 10):
        self._listeners = {}
        self._max = max_listeners

    def emit(self, event: str, data) -> None:
        handlers = self._listeners.get(event, [])
        for fn in handlers:
            fn(data)

    def dispose(self) -> None:
        self._listeners.clear()


class TypedEmitter(BaseEmitter, EventHandler):
    """Emitter that implements EventHandler."""

    def handle(self, event) -> None:
        self.emit("event", event)

    async def wait_for(self, event: str, timeout: float = 5.0) -> object:
        return await self._async_wait(event, timeout)

    @staticmethod
    def create() -> "TypedEmitter":
        return TypedEmitter()


def create_emitter(name: str = "default") -> TypedEmitter:
    emitter = TypedEmitter()
    return emitter


MAX_LISTENERS: int = 100
