import os
import pytest
from pathlib import Path

os.environ['DISABLE_METRICS'] = '1'

from config import Settings, GRPCConfig, ProcessingConfig, MetricsConfig

@pytest.fixture
def test_settings():
    return Settings(
        dbc_file=Path("tests/fixtures/test.dbc"),
        grpc=GRPCConfig(host="localhost", port=50052, max_workers=2),
        processing=ProcessingConfig(worker_pool_size=2),
        metrics=MetricsConfig(enabled=False)
    )

@pytest.fixture
def sample_can_frame():
    return bytes([0x61, 0x0C, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x45, 0x67])