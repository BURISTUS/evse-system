import pytest
import asyncio
from pathlib import Path
from unittest.mock import patch

from service import DBCService
from core.models import CommAddr, CommData
from utils.crc import CRC16ARC
from config import Settings, GRPCConfig, ProcessingConfig, MetricsConfig


class TestFullPipelineIntegration:
    @pytest.fixture
    def integration_settings(self, tmp_path):
        # Создаем тестовый DBC файл
        dbc_content = '''VERSION ""

BO_ 100 TestMessage: 8 Vector__XXX
 SG_ Signal1 : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Signal2 : 8|16@1+ (0.1,0) [0|6553.5] "V" Vector__XXX

BO_ 200 BroadcastMessage: 8 Vector__XXX
 SG_ Status : 0|8@1+ (1,0) [0|255] "" Vector__XXX
'''
        dbc_file = tmp_path / "integration_test.dbc"
        dbc_file.write_text(dbc_content)
        
        return Settings(
            dbc_file=dbc_file,
            grpc=GRPCConfig(host="localhost", port=50054, max_workers=4),
            processing=ProcessingConfig(worker_pool_size=2),
            metrics=MetricsConfig(enabled=False)
        )

    @pytest.fixture
    async def dbc_service(self, integration_settings):
        service = DBCService(integration_settings)
        await service.dbc_processor.initialize()  # Инициализируем DBC
        yield service
        await service.shutdown()

    def create_can_frame(self, dev_addr=1, msg_id=100, payload=None):
        """Создание валидного CAN кадра"""
        if payload is None:
            payload = bytes([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
        
        comm_addr = dev_addr | (msg_id << 5)
        crc_data = comm_addr.to_bytes(2, 'little') + payload
        crc = CRC16ARC.calculate(crc_data)
        
        return comm_addr.to_bytes(2, 'little') + payload + crc.to_bytes(2, 'little')

    async def test_full_pipeline_known_message(self, dbc_service):
        """Тест полного pipeline с известным сообщением"""
        frame = self.create_can_frame(dev_addr=1, msg_id=100)
        
        # Обрабатываем как в реальном сценарии
        await dbc_service.handle_message("test_topic", frame)
        
        # Проверяем статистику
        assert dbc_service.stats["total"] == 1
        assert dbc_service.stats["valid"] == 1
        assert dbc_service.stats["errors"] == 0

    async def test_full_pipeline_unknown_message(self, dbc_service):
        """Тест pipeline с неизвестным сообщением"""
        frame = self.create_can_frame(dev_addr=1, msg_id=999)  # Неизвестный ID
        
        await dbc_service.handle_message("unknown_topic", frame)
        
        assert dbc_service.stats["total"] == 1
        assert dbc_service.stats["valid"] == 1  # Парсинг успешен, но не найден в DBC
        assert dbc_service.stats["errors"] == 0

    async def test_full_pipeline_broadcast_message(self, dbc_service):
        """Тест pipeline с broadcast сообщением"""
        frame = self.create_can_frame(dev_addr=0, msg_id=200)  # Broadcast
        
        await dbc_service.handle_message("broadcast_topic", frame)
        
        assert dbc_service.stats["total"] == 1
        assert dbc_service.stats["valid"] == 1

    async def test_full_pipeline_invalid_frame(self, dbc_service):
        """Тест pipeline с невалидным кадром"""
        invalid_frame = b"invalid_data"
        
        await dbc_service.handle_message("invalid_topic", invalid_frame)
        
        assert dbc_service.stats["total"] == 1
        assert dbc_service.stats["errors"] == 1
        assert dbc_service.stats["valid"] == 0

    async def test_pipeline_under_load(self, dbc_service):
        """Тест pipeline под нагрузкой"""
        frame_count = 1000
        frames = [
            self.create_can_frame(dev_addr=(i % 30) + 1, msg_id=100)
            for i in range(frame_count)
        ]
        
        start_time = asyncio.get_event_loop().time()
        
        # Обрабатываем все кадры конкурентно
        tasks = [
            dbc_service.handle_message(f"topic_{i}", frame)
            for i, frame in enumerate(frames)
        ]
        await asyncio.gather(*tasks)
        
        end_time = asyncio.get_event_loop().time()
        duration = end_time - start_time
        
        assert dbc_service.stats["total"] == frame_count
        assert dbc_service.stats["valid"] == frame_count
        assert dbc_service.stats["errors"] == 0
        
        throughput = frame_count / duration
        assert throughput > 500, f"Throughput {throughput:.0f} fps слишком низкий"

    async def test_pipeline_mixed_scenarios(self, dbc_service):
        """Тест pipeline со смешанными сценариями"""
        # Смешиваем валидные, невалидные и неизвестные сообщения
        test_data = [
            ("valid", self.create_can_frame(dev_addr=1, msg_id=100)),
            ("invalid", b"short"),
            ("unknown", self.create_can_frame(dev_addr=2, msg_id=999)),
            ("broadcast", self.create_can_frame(dev_addr=0, msg_id=200)),
            ("corrupted_crc", self.create_can_frame(dev_addr=3, msg_id=100)[:-2] + b"\xFF\xFF"),
        ]
        
        for scenario, frame in test_data:
            await dbc_service.handle_message(f"topic_{scenario}", frame)
        
        # Проверяем общую статистику
        assert dbc_service.stats["total"] == 5
        assert dbc_service.stats["valid"] >= 2  # valid, broadcast минимум
        assert dbc_service.stats["errors"] >= 2  # invalid, corrupted_crc минимум

    async def test_stats_logging_integration(self, dbc_service):
        """Тест интеграции логирования статистики"""
        with patch('service.logger') as mock_logger:
            # Обрабатываем 1000 сообщений чтобы сработал лог
            for i in range(1000):
                frame = self.create_can_frame(dev_addr=1, msg_id=100)
                await dbc_service.handle_message(f"topic_{i}", frame)
            
            # Проверяем что статистика залогировалась
            mock_logger.info.assert_called_with("stats", **dbc_service.stats)
