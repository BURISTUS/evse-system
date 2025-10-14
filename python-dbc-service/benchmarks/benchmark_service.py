#!/usr/bin/env python3
"""
Benchmark тесты для DBC сервиса
Запуск: python benchmarks/benchmark_service.py
"""
import asyncio
import time
import statistics
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import List, Dict, Any
import numpy as np

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


class BenchmarkRunner:
    def __init__(self):
        self.results: List[BenchmarkResult] = []
    
    def create_test_frame(self, dev_addr: int = 1, msg_id: int = 100, payload: bytes = None) -> bytes:
        """Создание тестового CAN кадра с правильным CRC"""
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
    
    async def benchmark_crc_calculation(self, num_operations: int = 100000) -> BenchmarkResult:
        """Бенчмарк CRC вычислений"""
        print(f"🔧 Benchmarking CRC calculation ({num_operations:,} operations)...")
        
        test_data = [
            bytes([i % 256 for i in range(j, j + 10)])
            for j in range(0, num_operations, 13)  # Различные данные
        ]
        
        latencies = []
        errors = 0
        
        start_time = time.perf_counter()
        
        for data in test_data[:num_operations]:
            op_start = time.perf_counter()
            try:
                crc = CRC16ARC.calculate(data)
                assert 0 <= crc <= 0xFFFF
            except Exception:
                errors += 1
            op_end = time.perf_counter()
            latencies.append((op_end - op_start) * 1000)
        
        end_time = time.perf_counter()
        duration = end_time - start_time
        
        return BenchmarkResult(
            test_name="CRC Calculation",
            total_messages=num_operations,
            duration=duration,
            messages_per_second=num_operations / duration,
            avg_latency_ms=statistics.mean(latencies),
            p95_latency_ms=float(np.percentile(latencies, 95)) if latencies else 0.0,
            p99_latency_ms=float(np.percentile(latencies, 99)) if latencies else 0.0,
            errors=errors,
            memory_usage_mb=0  # Minimal memory for CRC
        )
    
    async def benchmark_frame_parsing(self, num_frames: int = 50000) -> BenchmarkResult:
        """Бенчмарк парсинга CAN кадров"""
        print(f"📋 Benchmarking frame parsing ({num_frames:,} frames)...")
        
        parser = FrameParser()
        
        # Создаем тестовые кадры
        frames = [
            self.create_test_frame(dev_addr=(i % 31) + 1, msg_id=(i % 500) + 100)
            for i in range(num_frames)
        ]
        
        latencies = []
        errors = 0
        
        start_time = time.perf_counter()
        
        for frame in frames:
            op_start = time.perf_counter()
            try:
                result = await parser.parse(frame)
                if result is None:
                    errors += 1
            except Exception:
                errors += 1
            op_end = time.perf_counter()
            latencies.append((op_end - op_start) * 1000)
        
        end_time = time.perf_counter()
        duration = end_time - start_time
        
        await parser.close()
        
        return BenchmarkResult(
            test_name="Frame Parsing",
            total_messages=num_frames,
            duration=duration,
            messages_per_second=num_frames / duration,
            avg_latency_ms=statistics.mean(latencies),
            p95_latency_ms=float(np.percentile(latencies, 95)) if latencies else 0.0,
            p99_latency_ms=float(np.percentile(latencies, 99)) if latencies else 0.0,
            errors=errors,
            memory_usage_mb=self.get_memory_usage()
        )
    
    async def benchmark_dbc_processing(self, num_messages: int = 25000) -> BenchmarkResult:
        """Бенчмарк DBC обработки"""
        print(f"🗃️  Benchmarking DBC processing ({num_messages:,} messages)...")
        
        tmp_path = Path("/tmp/dbc_benchmark")
        tmp_path.mkdir(exist_ok=True)
        dbc_file = self.create_test_dbc_file(tmp_path)
        
        processor = DBCProcessor(dbc_file)
        await processor.initialize()
        
        # Создаем тестовые сообщения
        messages = []
        for i in range(num_messages):
            comm_addr = CommAddr(
                dev_addr=(i % 31) + 1,
                msg_id=[100, 200, 300][i % 3],  # Известные сообщения
                reserved=0
            )
            comm_data = CommData(
                frame_id=comm_addr,
                data=bytes([(i + j) % 256 for j in range(8)]),
                crc16=0x1234
            )
            messages.append(comm_data)
        
        latencies = []
        errors = 0
        
        start_time = time.perf_counter()
        
        for i, message in enumerate(messages):
            op_start = time.perf_counter()
            try:
                result = await processor.process_message(message, f"topic_{i}")
                if result is None:
                    errors += 1
            except Exception:
                errors += 1
            op_end = time.perf_counter()
            latencies.append((op_end - op_start) * 1000)
        
        end_time = time.perf_counter()
        duration = end_time - start_time
        
        await processor.close()
        
        return BenchmarkResult(
            test_name="DBC Processing",
            total_messages=num_messages,
            duration=duration,
            messages_per_second=num_messages / duration,
            avg_latency_ms=statistics.mean(latencies),
            p95_latency_ms=float(np.percentile(latencies, 95)) if latencies else 0.0,
            p99_latency_ms=float(np.percentile(latencies, 99)) if latencies else 0.0,
            errors=errors,
            memory_usage_mb=self.get_memory_usage()
        )
    
    async def benchmark_grpc_publishing(self, num_messages: int = 20000) -> BenchmarkResult:
        """Бенчмарк gRPC публикации"""
        print(f"🌐 Benchmarking gRPC publishing ({num_messages:,} messages)...")
        
        config = GRPCConfig(host="localhost", port=50055, max_workers=8)
        server = GRPCServer(config)
        await server.start()
        
        # Создаем тестовые сообщения
        messages = [
            ParsedMessage(
                device_address=(i % 31) + 1,
                packet_type="broadcast" if i % 10 == 0 else "unicast",
                can_message_id=100 + (i % 200),
                message_name=f"TestMessage_{i % 3}",
                signals={"signal1": i % 256, "signal2": (i * 2) % 1024},
                raw_payload=f"{i:08d}".encode().hex().upper()[:16].ljust(16, '0'),
                crc16=f"0x{(i * 17) % 65536:04X}",
                crc_valid=True,
                timestamp=f"2024-01-01T{(i % 24):02d}:00:00",
                parsed=True
            )
            for i in range(num_messages)
        ]
        
        latencies = []
        errors = 0
        
        start_time = time.perf_counter()
        
        for message in messages:
            op_start = time.perf_counter()
            try:
                result = await server.publish_message(message)
                if not result:
                    errors += 1
            except Exception:
                errors += 1
            op_end = time.perf_counter()
            latencies.append((op_end - op_start) * 1000)
        
        end_time = time.perf_counter()
        duration = end_time - start_time
        
        await server.stop()
        
        return BenchmarkResult(
            test_name="gRPC Publishing",
            total_messages=num_messages,
            duration=duration,
            messages_per_second=num_messages / duration,
            avg_latency_ms=statistics.mean(latencies),
            p95_latency_ms=float(np.percentile(latencies, 95)) if latencies else 0.0,
            p99_latency_ms=float(np.percentile(latencies, 99)) if latencies else 0.0,
            errors=errors,
            memory_usage_mb=self.get_memory_usage()
        )
    
    async def benchmark_full_pipeline(self, num_frames: int = 10000) -> BenchmarkResult:
        """Бенчмарк полного pipeline"""
        print(f"🚀 Benchmarking full pipeline ({num_frames:,} frames)...")
        
        tmp_path = Path("/tmp/dbc_benchmark")
        tmp_path.mkdir(exist_ok=True)
        dbc_file = self.create_test_dbc_file(tmp_path)
        
        settings = Settings(
            dbc_file=dbc_file,
            grpc=GRPCConfig(host="localhost", port=50056, max_workers=8),
            processing=ProcessingConfig(worker_pool_size=4),
            metrics=MetricsConfig(enabled=False)
        )
        
        service = DBCService(settings)
        await service.dbc_processor.initialize()
        
        # Создаем тестовые кадры
        frames = [
            self.create_test_frame(dev_addr=(i % 31) + 1, msg_id=[100, 200, 300][i % 3])
            for i in range(num_frames)
        ]
        
        latencies = []
        
        start_time = time.perf_counter()
        
        for i, frame in enumerate(frames):
            op_start = time.perf_counter()
            await service.handle_message(f"topic_{i}", frame)
            op_end = time.perf_counter()
            latencies.append((op_end - op_start) * 1000)
        
        end_time = time.perf_counter()
        duration = end_time - start_time
        
        await service.shutdown()
        
        return BenchmarkResult(
            test_name="Full Pipeline",
            total_messages=num_frames,
            duration=duration,
            messages_per_second=num_frames / duration,
            avg_latency_ms=statistics.mean(latencies),
            p95_latency_ms=float(np.percentile(latencies, 95)) if latencies else 0.0,
            p99_latency_ms=float(np.percentile(latencies, 99)) if latencies else 0.0,
            errors=service.stats["errors"],
            memory_usage_mb=self.get_memory_usage()
        )
    
    async def benchmark_concurrent_processing(self, num_frames: int = 5000, concurrency: int = 10) -> BenchmarkResult:
        """Бенчмарк конкурентной обработки"""
        print(f"⚡ Benchmarking concurrent processing ({num_frames:,} frames, {concurrency} workers)...")
        
        tmp_path = Path("/tmp/dbc_benchmark")
        tmp_path.mkdir(exist_ok=True)
        dbc_file = self.create_test_dbc_file(tmp_path)
        
        settings = Settings(
            dbc_file=dbc_file,
            grpc=GRPCConfig(host="localhost", port=50057, max_workers=concurrency),
            processing=ProcessingConfig(worker_pool_size=concurrency),
            metrics=MetricsConfig(enabled=False)
        )
        
        service = DBCService(settings)
        await service.dbc_processor.initialize()
        
        # Создаем тестовые кадры
        frames = [
            self.create_test_frame(dev_addr=(i % 31) + 1, msg_id=[100, 200, 300][i % 3])
            for i in range(num_frames)
        ]
        
        start_time = time.perf_counter()
        
        # Обрабатываем конкурентно
        tasks = [
            service.handle_message(f"topic_{i}", frame)
            for i, frame in enumerate(frames)
        ]
        
        await asyncio.gather(*tasks)
        
        end_time = time.perf_counter()
        duration = end_time - start_time
        
        await service.shutdown()
        
        return BenchmarkResult(
            test_name=f"Concurrent Processing (x{concurrency})",
            total_messages=num_frames,
            duration=duration,
            messages_per_second=num_frames / duration,
            avg_latency_ms=duration * 1000 / num_frames,  # Приблизительная оценка
            p95_latency_ms=0,  # Сложно измерить для конкурентных задач
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
        """Печать результатов бенчмарков"""
        print("\n" + "="*80)
        print("🏁 BENCHMARK RESULTS")
        print("="*80)
        
        for result in self.results:
            print(f"\n📊 {result.test_name}")
            print(f"   Messages:     {result.total_messages:,}")
            print(f"   Duration:     {result.duration:.2f}s")
            print(f"   Throughput:   {result.messages_per_second:,.0f} msg/s")
            print(f"   Avg Latency:  {result.avg_latency_ms:.3f}ms")
            print(f"   P95 Latency:  {result.p95_latency_ms:.3f}ms")
            print(f"   P99 Latency:  {result.p99_latency_ms:.3f}ms")
            print(f"   Errors:       {result.errors}")
            if result.memory_usage_mb > 0:
                print(f"   Memory:       {result.memory_usage_mb:.1f}MB")
        
        # Сводная таблица
        print(f"\n📈 SUMMARY")
        print(f"{'Test':<25} {'Throughput (msg/s)':<18} {'Avg Latency (ms)':<16} {'Errors'}")
        print("-" * 70)
        
        for result in self.results:
            print(f"{result.test_name:<25} {result.messages_per_second:>15,.0f} "
                  f"{result.avg_latency_ms:>14.3f} {result.errors:>8}")
        
        # Находим лучший результат
        best_throughput = max(self.results, key=lambda x: x.messages_per_second)
        print(f"\n🏆 Best Throughput: {best_throughput.test_name} - {best_throughput.messages_per_second:,.0f} msg/s")
        
        if any(r.errors > 0 for r in self.results):
            print(f"⚠️  Some tests had errors - check implementation!")


async def main():
    """Запуск всех бенчмарков"""
    runner = BenchmarkRunner()
    
    print("🚀 Starting DBC Service Benchmarks...")
    print("This may take a few minutes...\n")
    
    try:
        # Запускаем все бенчмарки
        benchmarks = [
            runner.benchmark_crc_calculation(),
            runner.benchmark_frame_parsing(),
            runner.benchmark_dbc_processing(),
            runner.benchmark_grpc_publishing(),
            runner.benchmark_full_pipeline(),
            runner.benchmark_concurrent_processing(),
        ]
        
        for benchmark in benchmarks:
            result = await benchmark
            runner.results.append(result)
        
        runner.print_results()
        
    except KeyboardInterrupt:
        print("\n⚠️  Benchmarks interrupted by user")
    except Exception as e:
        print(f"\n❌ Benchmark failed: {e}")
        raise


if __name__ == "__main__":
    # Используем uvloop если доступен
    try:
        import uvloop
        uvloop.install()
        print("🔧 Using uvloop for better performance")
    except ImportError:
        print("⚠️  uvloop not available, using default event loop")
    
    asyncio.run(main())