import pytest
from unittest.mock import patch, MagicMock
from core.parser import FrameParser
from core.models import CommAddr, CommData
from utils.crc import CRC16ARC


class TestFrameParserExtended:
    @pytest.fixture
    async def parser(self):
        parser = FrameParser()
        yield parser
        await parser.close()

    def create_valid_frame(self, dev_addr=1, msg_id=100, payload=None):
        """Вспомогательный метод для создания валидного кадра"""
        if payload is None:
            payload = bytes([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
        
        comm_addr = dev_addr | (msg_id << 5)
        crc_data = comm_addr.to_bytes(2, 'little') + payload
        crc = CRC16ARC.calculate(crc_data)
        
        return comm_addr.to_bytes(2, 'little') + payload + crc.to_bytes(2, 'little')

    async def test_parse_valid_frame_broadcast(self, parser):
        """Тест парсинга broadcast кадра"""
        frame = self.create_valid_frame(dev_addr=0, msg_id=200)
        result = await parser.parse(frame)
        
        assert result is not None
        assert result.frame_id.dev_addr == 0
        assert result.frame_id.msg_id == 200
        assert result.frame_id.is_broadcast is True

    async def test_parse_valid_frame_unicast(self, parser):
        """Тест парсинга unicast кадра"""
        frame = self.create_valid_frame(dev_addr=15, msg_id=512)
        result = await parser.parse(frame)
        
        assert result is not None
        assert result.frame_id.dev_addr == 15
        assert result.frame_id.msg_id == 512
        assert result.frame_id.is_broadcast is False

    async def test_parse_edge_values(self, parser):
        """Тест граничных значений"""
        # Максимальные значения
        frame = self.create_valid_frame(dev_addr=31, msg_id=1023)
        result = await parser.parse(frame)
        
        assert result is not None
        assert result.frame_id.dev_addr == 31
        assert result.frame_id.msg_id == 1023

    async def test_parse_various_payloads(self, parser):
        """Тест различных payload'ов"""
        test_payloads = [
            bytes([0x00] * 8),  # Все нули
            bytes([0xFF] * 8),  # Все единицы
            bytes([0xAA, 0x55] * 4),  # Чередующиеся биты
            bytes(range(8)),  # Последовательность
        ]
        
        for payload in test_payloads:
            frame = self.create_valid_frame(payload=payload)
            result = await parser.parse(frame)
            
            assert result is not None
            assert result.data == payload

    async def test_parse_invalid_sizes(self, parser):
        """Тест различных неправильных размеров"""
        invalid_sizes = [0, 1, 5, 11, 13, 20, 100]
        
        for size in invalid_sizes:
            frame = bytes(size)
            result = await parser.parse(frame)
            assert result is None

    async def test_parse_crc_corruption(self, parser):
        """Тест различных повреждений CRC"""
        base_frame = self.create_valid_frame()
        
        # Портим последний байт (CRC)
        corrupted_frame = base_frame[:-1] + bytes([base_frame[-1] ^ 0xFF])
        result = await parser.parse(corrupted_frame)
        assert result is None
        
        # Портим предпоследний байт (CRC)
        corrupted_frame = base_frame[:-2] + bytes([base_frame[-2] ^ 0xFF]) + base_frame[-1:]
        result = await parser.parse(corrupted_frame)
        assert result is None

    @patch('core.parser.logger')
    async def test_logging_on_errors(self, mock_logger, parser):
        """Тест логирования при ошибках"""
        # Неправильный размер
        await parser.parse(b"short")
        mock_logger.warning.assert_called_with("invalid_frame_size", size=5)
        
        # Неправильный CRC
        frame = bytes(12)  # Создаем кадр с неправильным CRC
        frame_with_bad_crc = frame[:-2] + b"\xFF\xFF"
        await parser.parse(frame_with_bad_crc)
