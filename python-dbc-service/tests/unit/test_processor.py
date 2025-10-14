# tests/unit/test_processor_extended.py - расширенные тесты процессора
import pytest
from unittest.mock import Mock, patch, AsyncMock
from pathlib import Path
from core.processor import DBCProcessor
from core.models import CommAddr, CommData, ParsedMessage
import cantools


class TestDBCProcessorExtended:
    @pytest.fixture
    def mock_dbc_file(self, tmp_path):
        """Создание мокового DBC файла"""
        dbc_content = '''VERSION ""

BO_ 100 TestMessage: 8 Vector__XXX
 SG_ Signal1 : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Signal2 : 8|16@1+ (0.1,0) [0|6553.5] "V" Vector__XXX

BO_ 200 BroadcastMessage: 8 Vector__XXX
 SG_ Status : 0|8@1+ (1,0) [0|255] "" Vector__XXX
'''
        dbc_file = tmp_path / "test.dbc"
        dbc_file.write_text(dbc_content)
        return dbc_file

    @pytest.fixture
    async def processor(self, mock_dbc_file):
        processor = DBCProcessor(mock_dbc_file)
        await processor.initialize()
        yield processor
        await processor.close()

    def create_comm_data(self, dev_addr=1, msg_id=100, data=None):
        """Вспомогательный метод для создания CommData"""
        if data is None:
            data = bytes([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
        
        comm_addr = CommAddr(dev_addr=dev_addr, msg_id=msg_id, reserved=0)
        return CommData(frame_id=comm_addr, data=data, crc16=0x1234)

    async def test_initialize_success(self, mock_dbc_file):
        """Тест успешной инициализации"""
        processor = DBCProcessor(mock_dbc_file)
        assert processor.db is None
        
        await processor.initialize()
        
        assert processor.db is not None
        assert len(processor.db.messages) > 0

    async def test_initialize_missing_file(self):
        """Тест инициализации с отсутствующим файлом"""
        processor = DBCProcessor(Path("nonexistent.dbc"))
        
        with pytest.raises(Exception):  # cantools выбрасывает разные исключения
            await processor.initialize()

    async def test_process_known_message(self, processor):
        """Тест обработки известного сообщения"""
        comm_data = self.create_comm_data(dev_addr=1, msg_id=100)
        
        result = await processor.process_message(comm_data, "test_topic")
        
        assert result is not None
        assert result.device_address == 1
        assert result.can_message_id == 100
        assert result.parsed is True
        assert result.message_name == "TestMessage"
        assert "Signal1" in result.signals

    async def test_process_broadcast_message(self, processor):
        """Тест обработки broadcast сообщения"""
        comm_data = self.create_comm_data(dev_addr=0, msg_id=200)
        
        result = await processor.process_message(comm_data, "broadcast_topic")
        
        assert result is not None
        assert result.packet_type == "broadcast"
        assert result.message_name == "BroadcastMessage"

    async def test_process_unknown_message(self, processor):
        """Тест обработки неизвестного сообщения"""
        comm_data = self.create_comm_data(dev_addr=1, msg_id=999)
        
        result = await processor.process_message(comm_data, "unknown_topic")
        
        assert result is not None
        assert result.parsed is False
        assert "Unknown CAN ID: 999" in result.error

    async def test_message_caching(self, processor):
        """Тест кэширования сообщений"""
        comm_data = self.create_comm_data(dev_addr=1, msg_id=100)
        
        # Первый вызов - добавляет в кэш
        result1 = await processor.process_message(comm_data, "test1")
        assert 100 in processor._message_cache
        
        # Второй вызов - использует кэш
        result2 = await processor.process_message(comm_data, "test2")
        assert result1.message_name == result2.message_name

    async def test_process_without_initialization(self):
        """Тест обработки без инициализации"""
        processor = DBCProcessor(Path("test.dbc"))
        comm_data = self.create_comm_data()
        
        with pytest.raises(RuntimeError, match="DBC processor not initialized"):
            await processor.process_message(comm_data, "test")

    async def test_various_data_patterns(self, processor):
        """Тест различных паттернов данных"""
        test_data_patterns = [
            bytes([0x00] * 8),
            bytes([0xFF] * 8),
            bytes([0xAA, 0x55] * 4),
            bytes(range(8)),
        ]
        
        for data_pattern in test_data_patterns:
            comm_data = self.create_comm_data(data=data_pattern)
            result = await processor.process_message(comm_data, "pattern_test")
            
            assert result is not None
            assert result.raw_payload == data_pattern.hex().upper()