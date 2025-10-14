from __future__ import annotations

class CRC16ARC:
    @staticmethod
    def calculate(data: bytes) -> int:
        crc = 0x0000
        for byte in data:
            crc ^= byte
            for _ in range(8):
                if crc & 1:
                    crc = (crc >> 1) ^ 0xA001
                else:
                    crc >>= 1
        return crc & 0xFFFF

    @staticmethod
    def verify(data: bytes, expected_crc: int) -> bool:
        return CRC16ARC.calculate(data) == expected_crc