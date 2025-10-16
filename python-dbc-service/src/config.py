from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings


class GRPCConfig(BaseSettings):
    host: str = "localhost"
    port: int = 50051
    max_workers: int = 10
    max_message_size: int = 4 * 1024 * 1024


class ProcessingConfig(BaseSettings):
    max_batch_size: int = 1000
    worker_pool_size: int = 4
    max_queue_size: int = 100000
    batch_timeout_ms: float = 100.0


class LoggingConfig(BaseSettings):
    level: str = "INFO"
    format: str = "structured"
    log_to_file: bool = True
    log_file: Path = Path("logs/dbc_service.log")


class MetricsConfig(BaseSettings):
    enabled: bool = True
    port: int = 9091
    path: str = "/metrics"


class Settings(BaseSettings):
    dbc_file: Path = Field(default=Path("./dbc/charging_station.dbc"))
    
    grpc: GRPCConfig = Field(default_factory=GRPCConfig)
    processing: ProcessingConfig = Field(default_factory=ProcessingConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    metrics: MetricsConfig = Field(default_factory=MetricsConfig)

    class Config:
        env_nested_delimiter = "__"


def get_settings() -> Settings:
    return Settings()