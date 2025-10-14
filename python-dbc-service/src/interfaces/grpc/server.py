from __future__ import annotations
import asyncio
import structlog
import json
from grpc import aio

# Импорты generated proto файлов
from interfaces.grpc import dbc_pb2
from interfaces.grpc import dbc_pb2_grpc

from config import GRPCConfig
from core.models import ParsedMessage
from core.parser import FrameParser
from core.processor import DBCProcessor

logger = structlog.get_logger(__name__)


class DBCParserServicer(dbc_pb2_grpc.DBCParserServiceServicer):
    """Реализация gRPC сервиса парсинга DBC"""
    
    def __init__(self, frame_parser: FrameParser, dbc_processor: DBCProcessor):
        self.frame_parser = frame_parser
        self.dbc_processor = dbc_processor
    
    async def ParseFrame(self, request: dbc_pb2.ParseFrameRequest, context):
        """Парсинг одного фрейма"""
        print(f"🔍 Received frame: {request.frame_data}")
        print(f"   Timestamp: {request.timestamp}")
        
        try:
            # Парсим hex строку в bytes
            frame_bytes = bytes.fromhex(request.frame_data)
            print(f"   Frame bytes length: {len(frame_bytes)}")
            print(f"   Frame hex: {frame_bytes.hex()}")
            
            # Парсим фрейм
            comm_data = await self.frame_parser.parse(frame_bytes)
            print(f"   Parse result: {comm_data}")
            
            if not comm_data:
                print("   ❌ Parser returned None")
                return dbc_pb2.ParseFrameResponse(
                    parsed=False,
                    error="Failed to parse frame structure"
                )
            
            # Обрабатываем через DBC
            parsed = await self.dbc_processor.process_message(comm_data, "grpc")  # ← ЭТА СТРОКА ОТСУТСТВОВАЛА
            print(f"   [Server] Processor returned: {parsed}")

            if not parsed:
                print("   [Server] ❌ Processor returned None")
                return dbc_pb2.ParseFrameResponse(
                    parsed=False,
                    error="Failed to decode DBC message"
                )

            print(f"   [Server] Creating response...")
            print(f"   [Server]   - message_name: {parsed.message_name}")
            print(f"   [Server]   - device_address: {parsed.device_address}")
            print(f"   [Server]   - signals: {parsed.signals}")

            # Формируем ответ
            import orjson
            response = dbc_pb2.ParseFrameResponse(
                device_address=parsed.device_address,
                message_id=parsed.can_message_id,
                message_name=parsed.message_name,
                signals_json=orjson.dumps(parsed.signals).decode() if parsed.signals else "{}",
                raw_payload=parsed.raw_payload,
                crc_valid=True,
                parsed=True,
                timestamp=request.timestamp
            )

            print(f"   [Server] ✅ Response ready, sending back...")
            return response
            
        except Exception as e:
            logger.error("parse_frame_error", error=str(e))
            return dbc_pb2.ParseFrameResponse(
                parsed=False,
                error=str(e)
            )
    
    async def ParseBatch(self, request: dbc_pb2.ParseBatchRequest, context):
        """Парсинг батча фреймов"""
        for frame_req in request.frames:
            response = await self.ParseFrame(frame_req, context)
            yield response


class GRPCServer:
    def __init__(self, config: GRPCConfig, frame_parser: FrameParser, dbc_processor: DBCProcessor):
        self.config = config
        self.frame_parser = frame_parser
        self.dbc_processor = dbc_processor
        self._server: aio.Server | None = None
    
    async def start(self) -> None:
        self._server = aio.server()
        
        # Создаем и регистрируем servicer
        servicer = DBCParserServicer(self.frame_parser, self.dbc_processor)
        dbc_pb2_grpc.add_DBCParserServiceServicer_to_server(servicer, self._server)
        
        listen_addr = f"{self.config.host}:{self.config.port}"
        self._server.add_insecure_port(listen_addr)
        
        await self._server.start()
        logger.info("grpc_server_started", address=listen_addr)
        print(f"✅ gRPC server listening on {listen_addr}")
    
    async def serve(self) -> None:
        if self._server:
            await self._server.wait_for_termination()
    
    async def stop(self) -> None:
        if self._server:
            await self._server.stop(grace=5)
            logger.info("grpc_server_stopped")