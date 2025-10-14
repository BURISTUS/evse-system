import asyncio
import time
import redis.asyncio as redis
from concurrent.futures import ThreadPoolExecutor

async def benchmark_redis():
    """Benchmark Redis pub/sub performance"""
    client = redis.Redis(host="localhost", port=6379)
    
    # Test frame
    frame = bytes([
        0x61, 0x0C,  # COMM_ADDR
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,  # Payload
        0x45, 0x67   # CRC
    ])
    
    num_messages = 10000
    start_time = time.time()
    
    # Send messages
    for i in range(num_messages):
        await client.publish("dbc:input", frame)
    
    end_time = time.time()
    duration = end_time - start_time
    rate = num_messages / duration
    
    print(f"Redis benchmark:")
    print(f"  Messages: {num_messages}")
    print(f"  Duration: {duration:.2f}s")
    print(f"  Rate: {rate:.0f} msg/s")
    
    await client.close()

if __name__ == "__main__":
    asyncio.run(benchmark_redis())