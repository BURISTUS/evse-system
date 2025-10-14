#!/usr/bin/env python3
import sys
from pathlib import Path

# Добавляем src/ в PYTHONPATH
src_path = Path(__file__).parent / "src"
sys.path.insert(0, str(src_path))

def main():
    """Entry point для poetry script"""
    import asyncio
    import uvloop
    from main import main as async_main
    
    uvloop.install()
    asyncio.run(async_main())

if __name__ == "__main__":
    main()