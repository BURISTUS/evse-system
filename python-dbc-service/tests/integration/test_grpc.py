import pytest
import asyncio
import time
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor

from interfaces.grpc.server import GRPCServer
from core.models import ParsedMessage
from config import GRPCConfig


class TestGRPCServerIntegration:
    @pytest.fixture
    async def grpc_server(self, test_settings):
        server = GRPCServer(test_settings.grpc)
        await server.start()
        yield server
        await server.stop()

    def create_test_message(self, device_addr=1, can_id=100, **kwargs):
        """Helper для создания тестовых сообщений"""
        defaults = {
            'device_address': device_addr,
            'packet_type': 'broadcast' if device_addr == 0 else 'unicast',
            'can_message_id': can_id,
            'message_name': 'TestMessage',
            'signals': {'signal1': 42, 'signal2': 3.14},
            'raw_payload': '0102030405060708',
            'crc16': '0x1234',
            'crc_valid': True,
            'timestamp': '2024-01-01T00:00:00',
            'parsed': True
        }
        defaults.update(kwargs)
        return ParsedMessage(**defaults)

    async def test_publish_single_message(self, grpc_server):
        """Тест публикации одного сообщения"""
        message = self.create_test_message()
        result = await grpc_server.publish_message(message)
        assert result is True

    async def test_publish_broadcast_message(self, grpc_server):
        """Тест broadcast сообщения"""
        message = self.create_test_message(device_addr=0, packet_type='broadcast')
        result = await grpc_server.publish_message(message)
        assert result is True

    async def test_publish_unicast_message(self, grpc_server):
        """Тест unicast сообщения"""
        message = self.create_test_message(device_addr=15, packet_type='unicast')
        result = await grpc_server.publish_message(message)
        assert result is True

    async def test_publish_unparsed_message(self, grpc_server):
        """Тест неразобранного сообщения"""
        message = self.create_test_message(
            parsed=False,
            message_name=None,
            signals={},
            error='Unknown CAN ID: 999'
        )
        result = await grpc_server.publish_message(message)
        assert result is True

    async def test_publish_multiple_messages_sequential(self, grpc_server):
        """Тест последовательной публикации нескольких сообщений"""
        messages = [
            self.create_test_message(device_addr=i, can_id=100+i)
            for i in range(1, 11)
        ]
        
        results = []
        for message in messages:
            result = await grpc_server.publish_message(message)
            results.append(result)
        
        assert all(results), "Все сообщения должны быть опубликованы успешно"

    async def test_publish_multiple_messages_concurrent(self, grpc_server):
        """Тест конкурентной публикации сообщений"""
        messages = [
            self.create_test_message(device_addr=i, can_id=200+i)
            for i in range(1, 21)
        ]
        
        # Публикуем все сообщения конкурентно
        tasks = [
            grpc_server.publish_message(message)
            for message in messages
        ]
        
        results = await asyncio.gather(*tasks)
        assert all(results), "Все конкурентные сообщения должны быть опубликованы"

    async def test_high_frequency_publishing(self, grpc_server):
        """Тест высокочастотной публикации"""
        message_count = 1000
        messages = [
            self.create_test_message(can_id=i)
            for i in range(message_count)
        ]
        
        start_time = time.time()
        
        # Публикуем все сообщения
        tasks = [grpc_server.publish_message(msg) for msg in messages]
        results = await asyncio.gather(*tasks)
        
        end_time = time.time()
        duration = end_time - start_time
        
        assert all(results)
        assert duration < 5.0, f"1000 сообщений должны обрабатываться быстрее чем за 5сек, было {duration:.2f}с"
        
        messages_per_second = message_count / duration
        assert messages_per_second > 100, f"Скорость {messages_per_second:.0f} msg/s слишком низкая"

    async def test_message_handler_integration(self, grpc_server):
        """Тест интеграции с message handler"""
        handler_calls = []
        
        def test_handler(topic: str, payload: bytes):
            handler_calls.append((topic, payload))
        
        grpc_server.set_message_handler(test_handler)
        
        # Симулируем входящий запрос (упрощенно)
        test_payload = b"test_payload_data"
        # В реальном gRPC это было бы через ProcessFrames stream
        
        # Проверяем что handler установлен
        assert grpc_server._servicer._message_handler is not None

    async def test_queue_overflow_handling(self, grpc_server):
        """Тест обработки переполнения очереди"""
        # Заполняем очередь большим количеством сообщений
        overflow_count = 10000
        messages = [
            self.create_test_message(can_id=i)
            for i in range(overflow_count)
        ]
        
        # Публикуем много сообщений очень быстро
        results = await asyncio.gather(*[
            grpc_server.publish_message(msg) for msg in messages
        ], return_exceptions=True)
        
        # Должно быть либо все успешно, либо некоторые с предупреждениями
        successful_count = sum(1 for r in results if r is True)
        assert successful_count > 0, "Хотя бы некоторые сообщения должны быть обработаны"

    async def test_server_lifecycle(self):
        """Тест жизненного цикла сервера"""
        config = GRPCConfig(host="localhost", port=50053, max_workers=2)
        server = GRPCServer(config)
        
        # Сервер не запущен - публикация должна работать (очередь)
        message = self.create_test_message()
        result = await server.publish_message(message)
        assert result is True
        
        # Запускаем сервер
        await server.start()
        
        # Теперь должно работать нормально
        result = await server.publish_message(message)
        assert result is True
        
        # Останавливаем сервер
        await server.stop()
        
        # После остановки может не работать, но не должно падать
        try:
            result = await server.publish_message(message)
            # Результат может быть любым, главное чтобы не было исключения
        except Exception as e:
            pytest.fail(f"Публикация после остановки сервера вызвала исключение: {e}")