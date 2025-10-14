from __future__ import annotations

import os
import structlog
from config import MetricsConfig  # Абсолютный импорт

logger = structlog.get_logger(__name__)

# Отключить метрики для тестов
METRICS_DISABLED = os.getenv('DISABLE_METRICS', '0') == '1'

if not METRICS_DISABLED:
    from prometheus_client import Counter, Histogram, start_http_server
    
    PROCESSED_FRAMES = Counter("dbc_frames_processed_total", "Total processed frames", ["status"])
    PROCESSING_TIME = Histogram("dbc_processing_duration_seconds", "Frame processing time") 
    PUBLISHED_MESSAGES = Counter("dbc_messages_published_total", "Published messages", ["output_type"])
else:
    # Заглушки для тестов
    class MockMetric:
        def inc(self, *args, **kwargs): pass
        def observe(self, *args, **kwargs): pass
        def labels(self, *args, **kwargs): return self
    
    PROCESSED_FRAMES = MockMetric()
    PROCESSING_TIME = MockMetric() 
    PUBLISHED_MESSAGES = MockMetric()
    
    def start_http_server(*args, **kwargs): pass


class MetricsServer:
    def __init__(self, config: MetricsConfig) -> None:
        self.config = config
        self._server = None
    
    async def start(self) -> None:
        if self.config.enabled and not METRICS_DISABLED:
            start_http_server(self.config.port)
            logger.info("metrics_server_started", port=self.config.port)
    
    async def stop(self) -> None:
        logger.info("metrics_server_stopped")