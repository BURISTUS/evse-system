#!/usr/bin/env python3
"""
HIGH LOAD тест для проверки пределов оптимизированного DBC сервиса
"""
import asyncio
import time
import statistics
import sys
import numpy as np
from pathlib import Path
from dataclasses import dataclass
from typing import List

# Добавляем src в путь
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from utils.crc import CRC16ARC
from core.parser import FrameParser
from core.processor import DBCProcessor
from core.models import CommAddr, CommData, ParsedMessage
from interfaces.grpc.server import GRPCServer
from service import DBCService
from config import Settings, GRPCConfig, ProcessingConfig, MetricsConfig


@dataclass
class BenchmarkResult:
    test_name: str
    total_messages: int
    duration: float
    messages_per_second: float
    avg_latency_ms: float
    p95_latency_ms: float
    p99_latency_ms: float
    errors: int
    memory_usage_mb: float


class HighLoadTester:
    def __init__(self):
        self.results: List[BenchmarkResult] = []
    
    def create_test_frame(self, dev_addr: int = 1, msg_id: int = 100, payload: bytes = None) -> bytes:
        """Создание тестового CAN кадра"""
        if payload is None:
            payload = bytes([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
        
        comm_addr = dev_addr | (msg_id << 5)
        crc_data = comm_addr.to_bytes(2, 'little') + payload
        crc = CRC16ARC.calculate(crc_data)
        
        return comm_addr.to_bytes(2, 'little') + payload + crc.to_bytes(2, 'little')
    
    def create_test_dbc_file(self, tmp_path: Path) -> Path:
        """Создание тестового DBC файла"""
        dbc_content = '''VERSION ""

BO_ 100 TestMessage: 8 Vector__XXX
 SG_ Signal1 : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Signal2 : 8|16@1+ (0.1,0) [0|6553.5] "V" Vector__XXX

BO_ 200 BroadcastMessage: 8 Vector__XXX
 SG_ Status : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ Counter : 8|16@1+ (1,0) [0|65535] "" Vector__XXX

BO_ 300 HighFreqMessage: 8 Vector__XXX
 SG_ Data : 0|64@1+ (1,0) [0|18446744073709551615] "" Vector__XXX
'''
        dbc_file = tmp_path / "benchmark.dbc"
        dbc_file.write_text(dbc_content)
        return dbc_file

    async def test_dbc_extreme_load(self, num_messages: int = 500000) -> BenchmarkResult:
        """ЭКСТРЕМАЛЬНЫЙ тест DBC обработки - полмиллиона сообщений!"""
        print(f"🚀 EXTREME DBC LOAD TEST ({num_messages:,} messages)...")
        
        tmp_path = Path("/tmp/dbc_benchmark")
        tmp_path.mkdir(exist_ok=True)
        dbc_file = self.create_test_dbc_file(tmp_path)
        
        processor = DBCProcessor(dbc_file)
        await processor.initialize()
        
        # Создаем сообщения
        messages = []
        for i in range(num_messages):
            comm_addr = CommAddr(
                dev_addr=(i % 31) + 1,
                msg_id=[100, 200, 300][i % 3],
                reserved=0
            )
            comm_data = CommData(
                frame_id=comm_addr,
                data=bytes([(i + j) % 256 for j in range(8)]),
                crc16=0x1234
            )
            messages.append(comm_data)
        
        print(f"   Created {len(messages):,} test messages...")
        
        errors = 0
        batch_size = 10000
        latency_samples = []
        
        start_time = time.perf_counter()
        
        # Обрабатываем батчами для экономии памяти на латентности
        for batch_start in range(0, num_messages, batch_size):
            batch_end = min(batch_start + batch_size, num_messages)
            batch = messages[batch_start:batch_end]
            
            batch_start_time = time.perf_counter()
            
            for i, message in enumerate(batch):
                try:
                    result = await processor.process_message(message, f"topic_{batch_start + i}")
                    if result is None:
                        errors += 1
                except Exception:
                    errors += 1
            
            batch_end_time = time.perf_counter()
            batch_latency = ((batch_end_time - batch_start_time) * 1000) / len(batch)
            latency_samples.append(batch_latency)
            
            if batch_start % (batch_size * 10) == 0:
                processed = batch_start + len(batch)
                rate = processed / (time.perf_counter() - start_time)
                print(f"   Processed {processed:,}/{num_messages:,} ({rate:,.0f} msg/s)")
        
        end_time = time.perf_counter()
        duration = end_time - start_time
        
        await processor.close()
        
        return BenchmarkResult(
            test_name="EXTREME DBC LOAD",
            total_messages=num_messages,
            duration=duration,
            messages_per_second=num_messages / duration,
            avg_latency_ms=statistics.mean(latency_samples) if latency_samples else 0,
            p95_latency_ms=float(np.percentile(latency_samples, 95)) if latency_samples else 0,
            p99_latency_ms=float(np.percentile(latency_samples, 99)) if latency_samples else 0,
            errors=errors,
            memory_usage_mb=self.get_memory_usage()
        )

    async def test_full_pipeline_extreme(self, num_frames: int = 200000) -> BenchmarkResult:
        """ЭКСТРЕМАЛЬНЫЙ тест полного pipeline - 200k кадров!"""
        print(f"🔥 EXTREME FULL PIPELINE TEST ({num_frames:,} frames)...")
        
        tmp_path = Path("/tmp/dbc_benchmark")
        tmp_path.mkdir(exist_ok=True)
        dbc_file = self.create_test_dbc_file(tmp_path)
        
        settings = Settings(
            dbc_file=dbc_file,
            grpc=GRPCConfig(host="localhost", port=50061, max_workers=16),
            processing=ProcessingConfig(worker_pool_size=1),
            metrics=MetricsConfig(enabled=False)
        )
        
        service = DBCService(settings)
        await service.dbc_processor.initialize()
        
        # Создаем кадры
        frames = [
            self.create_test_frame(dev_addr=(i % 31) + 1, msg_id=[100, 200, 300][i % 3])
            for i in range(num_frames)
        ]
        
        print(f"   Created {len(frames):,} test frames...")
        
        start_time = time.perf_counter()
        
        # Обрабатываем последовательно для измерения точной латентности
        batch_size = 5000
        for batch_start in range(0, num_frames, batch_size):
            batch_end = min(batch_start + batch_size, num_frames)
            batch_frames = frames[batch_start:batch_end]
            
            for i, frame in enumerate(batch_frames):
                await service.handle_message(f"topic_{batch_start + i}", frame)
            
            if batch_start % (batch_size * 10) == 0:
                processed = batch_start + len(batch_frames)
                rate = processed / (time.perf_counter() - start_time)
                print(f"   Processed {processed:,}/{num_frames:,} ({rate:,.0f} msg/s)")
        
        end_time = time.perf_counter()
        duration = end_time - start_time
        
        await service.shutdown()
        
        return BenchmarkResult(
            test_name="EXTREME FULL PIPELINE",
            total_messages=num_frames,
            duration=duration,
            messages_per_second=num_frames / duration,
            avg_latency_ms=(duration * 1000) / num_frames,
            p95_latency_ms=0,  # Сложно измерить точно для такого объема
            p99_latency_ms=0,
            errors=service.stats["errors"],
            memory_usage_mb=self.get_memory_usage()
        )

    async def test_concurrent_massive(self, num_frames: int = 100000, concurrency: int = 32) -> BenchmarkResult:
        """МАССИВНЫЙ конкурентный тест - 100k кадров на 32 воркерах!"""
        print(f"⚡ MASSIVE CONCURRENT TEST ({num_frames:,} frames, {concurrency} workers)...")
        
        tmp_path = Path("/tmp/dbc_benchmark")
        tmp_path.mkdir(exist_ok=True)
        dbc_file = self.create_test_dbc_file(tmp_path)
        
        settings = Settings(
            dbc_file=dbc_file,
            grpc=GRPCConfig(host="localhost", port=50062, max_workers=concurrency),
            processing=ProcessingConfig(worker_pool_size=1),
            metrics=MetricsConfig(enabled=False)
        )
        
        service = DBCService(settings)
        await service.dbc_processor.initialize()
        
        # Создаем кадры
        frames = [
            self.create_test_frame(dev_addr=(i % 31) + 1, msg_id=[100, 200, 300][i % 3])
            for i in range(num_frames)
        ]
        
        print(f"   Created {len(frames):,} test frames...")
        print(f"   Starting concurrent processing with {concurrency} workers...")
        
        start_time = time.perf_counter()
        
        # Разбиваем на chunks для параллельной обработки
        chunk_size = max(1, num_frames // concurrency)
        chunks = [frames[i:i + chunk_size] for i in range(0, len(frames), chunk_size)]
        
        async def process_chunk(chunk, chunk_id):
            for i, frame in enumerate(chunk):
                await service.handle_message(f"topic_{chunk_id}_{i}", frame)
        
        # Конкурентная обработка всех chunks
        tasks = [process_chunk(chunk, i) for i, chunk in enumerate(chunks)]
        await asyncio.gather(*tasks)
        
        end_time = time.perf_counter()
        duration = end_time - start_time
        
        await service.shutdown()
        
        return BenchmarkResult(
            test_name=f"MASSIVE CONCURRENT (x{concurrency})",
            total_messages=num_frames,
            duration=duration,
            messages_per_second=num_frames / duration,
            avg_latency_ms=duration * 1000 / num_frames,
            p95_latency_ms=0,
            p99_latency_ms=0,
            errors=service.stats["errors"],
            memory_usage_mb=self.get_memory_usage()
        )

    def get_memory_usage(self) -> float:
        """Получить использование памяти в MB"""
        try:
            import psutil
            process = psutil.Process()
            return process.memory_info().rss / 1024 / 1024
        except ImportError:
            return 0.0

    def print_results(self):
        """Печать результатов HIGH LOAD тестов"""
        print("\n" + "="*80)
        print("🏆 HIGH LOAD BENCHMARK RESULTS")
        print("="*80)
        
        for result in self.results:
            print(f"\n🚀 {result.test_name}")
            print(f"   Messages:     {result.total_messages:,}")
            print(f"   Duration:     {result.duration:.2f}s")
            print(f"   Throughput:   {result.messages_per_second:,.0f} msg/s")
            print(f"   Avg Latency:  {result.avg_latency_ms:.3f}ms")
            if result.p95_latency_ms > 0:
                print(f"   P95 Latency:  {result.p95_latency_ms:.3f}ms")
                print(f"   P99 Latency:  {result.p99_latency_ms:.3f}ms")
            print(f"   Errors:       {result.errors}")
            if result.memory_usage_mb > 0:
                print(f"   Memory:       {result.memory_usage_mb:.1f}MB")
        
        # Финальный анализ
        if self.results:
            best = max(self.results, key=lambda x: x.messages_per_second)
            print(f"\n🏆 ABSOLUTE BEST: {best.test_name}")
            print(f"    🚀 PEAK PERFORMANCE: {best.messages_per_second:,.0f} msg/s")
            
            if best.messages_per_second >= 300000:
                print("🎉 INCREDIBLE! 300k+ msg/s achieved!")
            elif best.messages_per_second >= 200000:
                print("🔥 EXCELLENT! 200k+ msg/s achieved!")
            elif best.messages_per_second >= 100000:
                print("✅ GREAT! 100k+ msg/s target exceeded!")


async def main():
    """Запуск HIGH LOAD тестов"""
    tester = HighLoadTester()
    
    print("🚀 STARTING HIGH LOAD TESTS...")
    print("🎯 Testing the LIMITS of optimized DBC service")
    print("⚠️  This will take 10-15 minutes and use significant resources")
    print("")
    
    try:
        # Экстремальные тесты
        tests = [
            tester.test_dbc_extreme_load(500000),       # 500k сообщений DBC
            tester.test_full_pipeline_extreme(200000),   # 200k full pipeline  
            tester.test_concurrent_massive(100000, 32), # 100k concurrent x32
        ]
        
        for test in tests:
            print(f"\n{'='*60}")
            result = await test
            tester.results.append(result)
            print(f"✅ COMPLETED: {result.messages_per_second:,.0f} msg/s")
        
        tester.print_results()
        
    except KeyboardInterrupt:
        print("\n⚠️  HIGH LOAD tests interrupted")
    except Exception as e:
        print(f"\n❌ HIGH LOAD test failed: {e}")
        raise


if __name__ == "__main__":
    try:
        import uvloop
        uvloop.install()
        print("🔧 Using uvloop for maximum performance")
    except ImportError:
        print("⚠️  uvloop not available")
    
    asyncio.run(main())