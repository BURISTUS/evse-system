from __future__ import annotations

import structlog

from config import Settings
from core.parser import FrameParser
from core.processor import DBCProcessor
from interfaces.grpc.server import GRPCServer
from utils.metrics import MetricsServer

logger = structlog.get_logger(__name__)


class DBCService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.frame_parser = FrameParser()
        self.dbc_processor = DBCProcessor(settings.dbc_file)
        
        # Создаем grpc_server ПОСЛЕ frame_parser и dbc_processor
        self.grpc_server = GRPCServer(settings.grpc, self.frame_parser, self.dbc_processor)
        
        self.metrics_server: MetricsServer | None = None
        self.running = False
        self.stats: dict[str, int] = {"total": 0, "valid": 0, "errors": 0, "published": 0}
    
    async def start(self) -> None:
        logger.info("service_starting")
        
        await self.dbc_processor.initialize()
        
        if self.settings.metrics.enabled:
            self.metrics_server = MetricsServer(self.settings.metrics)
            await self.metrics_server.start()
        
        await self.grpc_server.start()
        
        print(f"✅ DBC Service started successfully!")
        print(f"🔧 gRPC server listening on {self.settings.grpc.host}:{self.settings.grpc.port}")
        print(f"📡 Ready to process frames...")
        logger.info("service_started")
        
        self.running = True
        
        await self.grpc_server.serve()
    
    async def shutdown(self) -> None:
        logger.info("service_shutting_down")
        self.running = False
        
        await self.grpc_server.stop()
        
        if self.metrics_server:
            await self.metrics_server.stop()
        
        await self.frame_parser.close()
        await self.dbc_processor.close()
        
        logger.info("service_stopped", final_stats=self.stats)