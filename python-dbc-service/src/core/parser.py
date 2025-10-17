from __future__ import annotations

import struct
from typing import Optional
import structlog

from .models import CommAddr, CommData

logger = structlog.get_logger(__name__)


class FrameParser:
    def __init__(self) -> None:
        self._addr_format = '<H'
        self._min_frame_size = 12
        
    async def parse(self, payload: bytes) -> CommData | None:
        logger.debug("parsing_frame", payload_length=len(payload))
        
        if len(payload) != self._min_frame_size:
            logger.warning("invalid_frame_size", size=len(payload), expected=self._min_frame_size)
            return None
        
        try:
            comm_addr_bytes = payload[:2]
            can_data = payload[2:10]
            crc_bytes = payload[10:12]
            
            comm_addr_value = int.from_bytes(comm_addr_bytes, 'little')
            dev_addr = comm_addr_value & 0x1F
            msg_id = (comm_addr_value >> 5) & 0x3FF
            reserved = (comm_addr_value >> 15) & 0x1
            
            logger.debug("frame_decoded", dev_addr=dev_addr, msg_id=msg_id, reserved=reserved)
            
            comm_addr = CommAddr(dev_addr=dev_addr, msg_id=msg_id, reserved=reserved)
            crc_value = int.from_bytes(crc_bytes, 'little')
            
            return CommData(
                frame_id=comm_addr, 
                data=can_data, 
                crc16=crc_value,
                crc_valid=True
            )
                  
        except (struct.error, IndexError, ValueError) as e:
            logger.error("frame_parse_error", error=str(e))
            return None
    
    async def close(self) -> None:
        pass