from __future__ import annotations

import asyncio
import signal

import uvloop

from config import get_settings
from service import DBCService
from utils.logging import setup_logging


async def main() -> None:
    settings = get_settings()
    logger = setup_logging(settings.logging.level, settings.logging.format)
    
    service = DBCService(settings)
    
    def signal_handler() -> None:
        logger.info("shutdown_signal_received")
        asyncio.create_task(service.shutdown())
    
    for sig in [signal.SIGINT, signal.SIGTERM]:
        asyncio.get_event_loop().add_signal_handler(sig, signal_handler)
    
    try:
        await service.start()
    except Exception as e:
        logger.error("service_error", error=str(e))
        raise


if __name__ == "__main__":
    uvloop.install()
    asyncio.run(main())