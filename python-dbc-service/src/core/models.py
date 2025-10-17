# src/core/models.py
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class CommAddr(BaseModel):
    dev_addr: int = Field(ge=0, le=31)      # 5 бит (0-31)
    msg_id: int = Field(ge=0, le=1023)     # 10 бит (0-1023) ← ИСПРАВЛЕНО с 511
    reserved: int = Field(ge=0, le=1)       # 1 бит

    @property
    def is_broadcast(self) -> bool:
        return self.dev_addr == 0


class CommData(BaseModel):
    frame_id: CommAddr
    data: bytes = Field(min_length=8, max_length=8)
    crc16: int
    crc_valid: bool = True 
    timestamp: datetime = Field(default_factory=datetime.now)


class ParsedMessage(BaseModel):
    device_address: int
    packet_type: str
    can_message_id: int
    message_name: str | None = None
    signals: dict[str, Any] = Field(default_factory=dict)
    raw_payload: str
    crc16: str
    crc_valid: bool
    timestamp: str
    parsed: bool
    source_topic: str | None = None
    error: str | None = None