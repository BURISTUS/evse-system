import pytest
from unittest.mock import AsyncMock, Mock, patch
from pathlib import Path

from service import DBCService
from config import Settings, GRPCConfig, ProcessingConfig, MetricsConfig


class TestDBCServiceExtended:
    @pytest.fixture
    def test_settings(self):
        return Settings(
            dbc_file=Path("tests/fixtures/test.dbc"),
            grpc=GRPCConfig(host="localhost", port=50052, max_workers=2),
            processing=ProcessingConfig(worker_pool_size=2),
            metrics=MetricsConfig(enabled=False)  # Реальный объект вместо Mock
        )

    @pytest.fixture
    def mock_service(self, test_settings):
        service = DBCService(test_settings)
        service.frame_parser = AsyncMock()
        service.dbc_processor = AsyncMock()  
        service.grpc_server = AsyncMock()
        service.metrics_server = AsyncMock()  # Можно мокать после создания
        return service

    @pytest.fixture
    def mock_service(self, test_settings):
        service = DBCService(test_settings)
        service.frame_parser = AsyncMock()
        service.dbc_processor = AsyncMock()
        service.grpc_server = AsyncMock()
        service.metrics_server = AsyncMock()
        return service

    async def test_handle_message_success_flow(self, mock_service):
        """Тест успешного flow обработки сообщения"""
        # Настройка моков
        mock_comm_data = Mock()
        mock_parsed_message = Mock()
        
        mock_service.frame_parser.parse.return_value = mock_comm_data
        mock_service.dbc_processor.process_message.return_value = mock_parsed_message
        mock_service.grpc_server.publish_message.return_value = True
        
        # Выполнение
        await mock_service.handle_message("test_topic", b"test_payload")
        
        # Проверки
        assert mock_service.stats["total"] == 1
        assert mock_service.stats["valid"] == 1
        assert mock_service.stats["published"] == 1
        assert mock_service.stats["errors"] == 0
        
        mock_service.frame_parser.parse.assert_called_once_with(b"test_payload")
        mock_service.dbc_processor.process_message.assert_called_once_with(mock_comm_data, "test_topic")
        mock_service.grpc_server.publish_message.assert_called_once_with(mock_parsed_message)

    async def test_handle_message_parse_failure(self, mock_service):
        """Тест ошибки парсинга"""
        mock_service.frame_parser.parse.return_value = None
        
        await mock_service.handle_message("test_topic", b"invalid_payload")
        
        assert mock_service.stats["total"] == 1
        assert mock_service.stats["errors"] == 1
        assert mock_service.stats["valid"] == 0

    async def test_handle_message_processing_failure(self, mock_service):
        """Тест ошибки обработки DBC"""
        mock_comm_data = Mock()
        mock_service.frame_parser.parse.return_value = mock_comm_data
        mock_service.dbc_processor.process_message.return_value = None
        
        await mock_service.handle_message("test_topic", b"test_payload")
        
        assert mock_service.stats["total"] == 1
        assert mock_service.stats["errors"] == 1
        assert mock_service.stats["valid"] == 0

    async def test_handle_message_publish_failure(self, mock_service):
        """Тест ошибки публикации"""
        mock_comm_data = Mock()
        mock_parsed_message = Mock()
        
        mock_service.frame_parser.parse.return_value = mock_comm_data
        mock_service.dbc_processor.process_message.return_value = mock_parsed_message
        mock_service.grpc_server.publish_message.return_value = False
        
        await mock_service.handle_message("test_topic", b"test_payload")
        
        assert mock_service.stats["total"] == 1
        assert mock_service.stats["valid"] == 1
        assert mock_service.stats["published"] == 0

    async def test_stats_logging(self, mock_service):
        """Тест логирования статистики каждые 1000 сообщений"""
        mock_comm_data = Mock()
        mock_parsed_message = Mock()
        
        mock_service.frame_parser.parse.return_value = mock_comm_data
        mock_service.dbc_processor.process_message.return_value = mock_parsed_message
        mock_service.grpc_server.publish_message.return_value = True
        
        with patch('service.logger') as mock_logger:
            # Обработаем 1000 сообщений
            for i in range(1000):
                await mock_service.handle_message(f"topic_{i}", b"payload")
            
            # Проверяем, что статистика залогирована
            mock_logger.info.assert_called_with("stats", **mock_service.stats)

    async def test_handle_message_exception(self, mock_service):
        """Тест обработки исключений"""
        mock_service.frame_parser.parse.side_effect = Exception("Test exception")
        
        with patch('service.logger') as mock_logger:
            await mock_service.handle_message("test_topic", b"test_payload")
            
            assert mock_service.stats["errors"] == 1
            mock_logger.error.assert_called_with("process_error", error="Test exception")