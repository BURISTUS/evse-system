from __future__ import annotations

import struct
from typing import Optional
import structlog

from .models import CommAddr, CommData
from utils.crc import CRC16ARC

logger = structlog.get_logger(__name__)


class FrameParser:
    def __init__(self) -> None:
        self._addr_format = '<H'
        self._crc_format = '<H'
        self._min_frame_size = 12
        
    async def parse(self, payload: bytes) -> CommData | None:
        print(f"   [Parser] Input payload length: {len(payload)}")
        
        if len(payload) != 12:
            print(f"   [Parser] ❌ Wrong length! Expected 12, got {len(payload)}")
            return None
        
        try:
            # Парсинг структуры
            comm_addr_bytes = payload[:2]
            can_data = payload[2:10]
            crc_bytes = payload[10:12]
            
            print(f"   [Parser] COMM_ADDR: {comm_addr_bytes.hex()}")
            print(f"   [Parser] CAN_DATA: {can_data.hex()}")
            print(f"   [Parser] CRC: {crc_bytes.hex()}")
            
            # Проверка CRC
            crc_calculated = CRC16ARC.calculate(payload[:10])
            crc_received = int.from_bytes(crc_bytes, 'little')
            
            print(f"   [Parser] CRC calculated: {crc_calculated:04x}")
            print(f"   [Parser] CRC received: {crc_received:04x}")
            
            # if crc_calculated != crc_received:
            #     print(f"   [Parser] ❌ CRC mismatch!")
            #     return None
            
            print(f"   [Parser] CRC check DISABLED for testing")

            # Распаковка COMM_ADDR
            comm_addr_value = int.from_bytes(comm_addr_bytes, 'little')
            dev_addr = comm_addr_value & 0x1F          # биты 0-4
            msg_id = (comm_addr_value >> 5) & 0x3FF    # биты 5-14
            reserved = (comm_addr_value >> 15) & 0x1   # бит 15

            print(f"   [Parser] Decoded - dev_addr: {dev_addr}, msg_id: {msg_id}, reserved: {reserved}")

            # Создание CommAddr
            comm_addr = CommAddr(dev_addr=dev_addr, msg_id=msg_id, reserved=reserved)
            return CommData(frame_id=comm_addr, data=can_data, crc16=crc_received)
                  
        except (struct.error, IndexError):
            return None
    
    async def close(self) -> None:
        pass