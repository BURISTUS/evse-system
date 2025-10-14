from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Dict
from functools import lru_cache

import cantools
import structlog

from .models import CommData, ParsedMessage

logger = structlog.get_logger(__name__)


class DBCProcessor:
    """ОПТИМИЗИРОВАННЫЙ DBC процессор - сохраняет все существующие интерфейсы!"""
    
    def __init__(self, dbc_file: Path, max_workers: int = 4) -> None:
        self.dbc_file = dbc_file
        self.db: cantools.database.Database | None = None
        
        # ❌ УБИРАЕМ ThreadPoolExecutor - главный источник overhead!
        # self._executor = ThreadPoolExecutor(max_workers=max_workers, ...)
        
        # ✅ Предварительное кэширование ВСЕХ сообщений для мгновенного доступа
        self._message_cache: Dict[int, cantools.database.Message] = {}
        self._message_names: Dict[int, str] = {}

    async def initialize(self) -> None:
        """Инициализация с предварительным кэшированием"""
        try:
            # ✅ Синхронная загрузка (один раз при старте)
            self.db = cantools.database.load_file(str(self.dbc_file))
            
            # ✅ Кэшируем ВСЕ сообщения заранее
            self._preload_all_messages()
            
            logger.info(
                "dbc_loaded", 
                file=str(self.dbc_file), 
                messages=len(self.db.messages),
                cached=len(self._message_cache)
            )
        except Exception as e:
            logger.error("dbc_load_failed", file=str(self.dbc_file), error=str(e))
            raise

    def _preload_all_messages(self) -> None:
        """Загружаем все сообщения в кэш заранее"""
        if not self.db:
            return
            
        for message in self.db.messages:
            self._message_cache[message.frame_id] = message
            self._message_names[message.frame_id] = message.name

    async def process_message(
        self, comm_data: CommData, source_topic: str = ""
    ) -> ParsedMessage | None:
        """
        КЛЮЧЕВАЯ ОПТИМИЗАЦИЯ: убираем run_in_executor!
        Сохраняем async интерфейс для совместимости, но обработка синхронная
        """
        if not self.db:
            raise RuntimeError("DBC processor not initialized")

        # ❌ Старый код с overhead:
        # return await asyncio.get_event_loop().run_in_executor(
        #     self._executor, self._process_sync, comm_data, source_topic
        # )
        
        # ✅ Новый код - прямой вызов:
        return self._process_sync(comm_data, source_topic)

    def _process_sync(self, comm_data: CommData, source_topic: str) -> ParsedMessage:
        """Оптимизированная синхронная обработка"""
        can_id = comm_data.frame_id.msg_id
        dev_addr = comm_data.frame_id.dev_addr
        packet_type = "broadcast" if comm_data.frame_id.is_broadcast else "unicast"

        print(f"   [Processor] Processing msg_id: {can_id}, dev_addr: {dev_addr}")

        try:
            # Мгновенный доступ из предварительного кэша
            message = self._message_cache.get(can_id)
            if message is None:
                print(f"   [Processor] Message {can_id} not in cache, loading...")
                message = self.db.get_message_by_frame_id(can_id)
                self._message_cache[can_id] = message

            print(f"   [Processor] Found message: {message.name}")
            
            # Декодируем (БЕЗ кэша - он не работает)
            decoded_signals = message.decode(comm_data.data)
            print(f"   [Processor] Decoded signals: {decoded_signals}")

            return ParsedMessage(
                device_address=dev_addr,
                packet_type=packet_type,
                can_message_id=can_id,
                message_name=self._message_names.get(can_id, message.name),
                signals=decoded_signals,
                raw_payload=comm_data.data.hex().upper(),
                crc16=f"0x{comm_data.crc16:04X}",
                crc_valid=True,
                timestamp="",
                parsed=True
            )

        except Exception as e:
            print(f"   [Processor] ❌ Error: {str(e)}")
            logger.debug("decode_error", can_id=can_id, error=str(e))
            return ParsedMessage(
                device_address=dev_addr,
                packet_type=packet_type,
                can_message_id=can_id,
                message_name="Unknown",
                signals={},
                raw_payload=comm_data.data.hex().upper(),
                crc16=f"0x{comm_data.crc16:04X}",
                crc_valid=False,
                timestamp="",
                parsed=False,
                error=f"Unknown CAN ID: {can_id}"
            )

    @lru_cache(maxsize=2000)  # ✅ Кэшируем результаты декодирования
    def _decode_message_fast(self, message: cantools.database.Message, data: bytes) -> dict:
        """Быстрое декодирование с кэшированием"""
        return message.decode(data)

    async def close(self) -> None:
        """Очистка ресурсов"""
        # ❌ Старый код:
        # if hasattr(self, '_executor'):
        #     self._executor.shutdown(wait=True)
        
        # ✅ Новый код:
        self._message_cache.clear()
        self._message_names.clear()
        
        logger.info("dbc_processor_closed")