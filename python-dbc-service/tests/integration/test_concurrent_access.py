import pytest
import asyncio
from concurrent.futures import ThreadPoolExecutor, as_completed


class TestConcurrentAccess:
    async def test_concurrent_frame_parsing(self):
        """Тест конкурентного парсинга кадров"""
        from core.parser import FrameParser
        from utils.crc import CRC16ARC
        
        parser = FrameParser()
        
        def create_frame(i):
            comm_addr = 1 | (100 << 5)
            payload = bytes([(i + j) % 256 for j in range(8)])
            crc_data = comm_addr.to_bytes(2, 'little') + payload
            crc = CRC16ARC.calculate(crc_data)
            return comm_addr.to_bytes(2, 'little') + payload + crc.to_bytes(2, 'little')
        
        frames = [create_frame(i) for i in range(100)]
        
        # Парсим конкурентно
        tasks = [parser.parse(frame) for frame in frames]
        results = await asyncio.gather(*tasks)
        
        # Все должны быть успешно распарсены
        assert all(r is not None for r in results)
        
        await parser.close()

    async def test_concurrent_dbc_processing(self, tmp_path):
        """Тест конкурентной обработки DBC"""
        from core.processor import DBCProcessor
        from core.models import CommAddr, CommData
        
        # Создаем DBC файл
        dbc_content = '''VERSION ""
BO_ 100 TestMessage: 8 Vector__XXX
 SG_ Signal1 : 0|8@1+ (1,0) [0|255] "" Vector__XXX
'''
        dbc_file = tmp_path / "concurrent_test.dbc"
        dbc_file.write_text(dbc_content)
        
        processor = DBCProcessor(dbc_file)
        await processor.initialize()
        
        # Создаем множество сообщений для обработки
        messages = []
        for i in range(50):
            comm_addr = CommAddr(dev_addr=(i % 30) + 1, msg_id=100, reserved=0)
            comm_data = CommData(
                frame_id=comm_addr,
                data=bytes([(i + j) % 256 for j in range(8)]),
                crc16=0x1234
            )
            messages.append(comm_data)
        
        # Обрабатываем конкурентно
        tasks = [
            processor.process_message(msg, f"topic_{i}")
            for i, msg in enumerate(messages)
        ]
        results = await asyncio.gather(*tasks)
        
        # Все должны быть обработаны
        assert all(r is not None for r in results)
        assert all(r.parsed for r in results)
        
        await processor.close()