#!/usr/bin/env python3
import grpc
import sys
import os
import struct

# Добавляем src в PYTHONPATH
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, current_dir)

# Исправляем импорт, обходя проблемный src/__init__.py
try:
    # Прямой импорт из grpc папки, обходя src пакет
    grpc_path = os.path.join(current_dir, 'src', 'grpc')
    if grpc_path not in sys.path:
        sys.path.insert(0, grpc_path)
    
    import dbc_pb2
    import dbc_pb2_grpc
    print("✅ Protobuf imports successful")
    
except ImportError as e:
    print(f"❌ Import error: {e}")
    print("🔧 Checking if protobuf files exist...")
    
    grpc_dir = os.path.join(current_dir, 'src', 'grpc')
    pb2_file = os.path.join(grpc_dir, 'dbc_pb2.py')
    pb2_grpc_file = os.path.join(grpc_dir, 'dbc_pb2_grpc.py')
    
    if not os.path.exists(pb2_file):
        print(f"❌ Missing: {pb2_file}")
        print("💡 Run: python3 setup.py")
        sys.exit(1)
    
    if not os.path.exists(pb2_grpc_file):
        print(f"❌ Missing: {pb2_grpc_file}")
        print("💡 Run: python3 setup.py")
        sys.exit(1)
    
    print("Files exist, trying alternative import...")
    
    # Альтернативный способ импорта
    try:
        spec_pb2 = importlib.util.spec_from_file_location("dbc_pb2", pb2_file)
        dbc_pb2 = importlib.util.module_from_spec(spec_pb2)
        spec_pb2.loader.exec_module(dbc_pb2)
        
        spec_pb2_grpc = importlib.util.spec_from_file_location("dbc_pb2_grpc", pb2_grpc_file)
        dbc_pb2_grpc = importlib.util.module_from_spec(spec_pb2_grpc)
        spec_pb2_grpc.loader.exec_module(dbc_pb2_grpc)
        
        print("✅ Alternative import successful")
    except Exception as e2:
        print(f"❌ Alternative import failed: {e2}")
        sys.exit(1)

def create_test_frame(dev_addr: int, msg_id: int, can_data: bytes) -> str:
    """Создание тестового 12-байтового фрейма"""
    # Формируем COMM_ADDR
    comm_addr = (dev_addr & 0x1F) | ((msg_id & 0x3FF) << 5)
    comm_addr_bytes = struct.pack('<H', comm_addr)
    
    # Дополняем CAN данные до 8 байт
    padded_data = can_data + b'\x00' * (8 - len(can_data))
    
    # Вычисляем CRC16 (пока заглушка)
    payload = comm_addr_bytes + padded_data
    crc16 = 0x1234  # Заглушка для тестирования
    crc16_bytes = struct.pack('<H', crc16)
    
    frame = payload + crc16_bytes
    return frame.hex().upper()

def test_dbc_service():
    """Тестирование gRPC DBC Service"""
    
    try:
        with grpc.insecure_channel('localhost:50051') as channel:
            stub = dbc_pb2_grpc.DBCParserServiceStub(channel)
            
            print("Тестирование Python DBC Service через gRPC...")
            
            # Health check
            try:
                health = stub.HealthCheck(dbc_pb2.Empty())
                print(f"✅ Health: {health.status}, DBC loaded: {health.dbc_loaded}, Uptime: {health.uptime_seconds}s")
            except grpc.RpcError as e:
                print(f"❌ Service unavailable: {e.details()}")
                print("💡 Make sure the server is running: python3 main.py")
                return
            
            # DBC info
            try:
                info = stub.GetDBCInfo(dbc_pb2.Empty())
                print(f"✅ DBC Info: {info.dbc_file}, Messages: {info.total_messages}")
                print(f"   Loaded at: {info.loaded_at}")
                
                # Парсим доступные сообщения
                import json
                messages = json.loads(info.messages_json)
                print("   Available messages:")
                for msg_id, msg_name in messages.items():
                    print(f"     ID {msg_id}: {msg_name}")
            except grpc.RpcError as e:
                print(f"❌ Failed to get DBC info: {e.details()}")
                return
            
            print("\n" + "="*50)
            
            test_cases = [
                {
                    "name": "evse_session",
                    "id": 17,
                    "data": struct.pack('<HHH', 42, 125, 15500)[:6],  # Обрезаем до 6 байт согласно DBC
                    "description": "Данные сессии зарядки"
                },
                {
                    "name": "evse_state", 
                    "id": 16,
                    "data": struct.pack('<BBBBBBBB', 0x03, 0x12, 0x00, 0x45, 0x23, 0x01, 0x00, 0x00),  # 8 байт
                    "description": "Состояние устройства"
                },
                {
                    "name": "evse_data1",
                    "id": 19,
                    "data": struct.pack('<BBBBBBBB', 16, 15, 16, 0, 0, 0, 156, 20),  # 8 байт (power упаковываем в 2 байта)
                    "description": "Данные токов и мощности"
                },
                {
                    "name": "evse_data2",
                    "id": 20,
                    "data": struct.pack('<HHHbb', 230, 235, 232, 45, 38),  # 8 байт (3H + 2b = 8)
                    "description": "Данные напряжений и температур"
                },
                {
                    "name": "remote_cmd",
                    "id": 34,
                    "data": struct.pack('<BBHH', 0x01, 0x11, 120, 50000)[:6],  # Обрезаем до 6 байт согласно DBC
                    "description": "Команды управления"
                }
            ]
            
            for test_case in test_cases:
                print(f"\n🧪 Тестирование {test_case['name']} (ID: {test_case['id']})")
                print(f"   {test_case['description']}")
                
                # Создаем тестовый фрейм
                frame_data = create_test_frame(1, test_case['id'], test_case['data'])
                print(f"   Frame data: {frame_data}")
                
                # Парсим фрейм
                request = dbc_pb2.ParseFrameRequest(
                    frame_data=frame_data,
                    timestamp="2025-01-15T10:30:45Z"
                )
                
                try:
                    response = stub.ParseFrame(request)
                    print(f"   ✅ Device Address: {response.device_address}")
                    print(f"   ✅ Message: {response.message_name} (ID: {response.message_id})")
                    print(f"   ✅ CRC Valid: {response.crc_valid}")
                    print(f"   ✅ Parsed: {response.parsed}")
                    
                    if response.signals_json and response.signals_json != "{}":
                        import json
                        signals = json.loads(response.signals_json)
                        print(f"   ✅ Signals:")
                        for signal_name, value in signals.items():
                            print(f"      {signal_name}: {value}")
                    
                    if response.error:
                        print(f"   ⚠️  Error: {response.error}")
                        
                except grpc.RpcError as e:
                    print(f"   ❌ Parse error: {e.details()}")
            
            print("\n" + "="*50)
            
            # Тестирование batch обработки
            print("\n🧪 Тестирование batch обработки...")
            batch_frames = []
            for i, test_case in enumerate(test_cases[:3]):  # Берем первые 3
                frame_data = create_test_frame(i+1, test_case['id'], test_case['data'])
                batch_frames.append(dbc_pb2.ParseFrameRequest(
                    frame_data=frame_data,
                    timestamp=f"2025-01-15T10:3{i}:45Z"
                ))
            
            try:
                batch_request = dbc_pb2.ParseBatchRequest(frames=batch_frames)
                responses = list(stub.ParseBatch(batch_request))
                print(f"   ✅ Batch processed: {len(responses)} frames")
                
                for i, response in enumerate(responses):
                    print(f"   Frame {i+1}: {response.message_name}, Parsed: {response.parsed}")
                    
            except grpc.RpcError as e:
                print(f"   ❌ Batch error: {e.details()}")
            
            print("\n" + "="*50)
            
            # Тестирование невалидных данных
            print("\n🧪 Тестирование обработки ошибок...")
            
            error_tests = [
                {
                    "name": "Неправильная длина",
                    "frame": "DEADBEEF",  # Слишком короткий
                },
                {
                    "name": "Неизвестный ID сообщения", 
                    "frame": create_test_frame(1, 999, b'\x00\x01\x02\x03'),
                },
                {
                    "name": "Невалидный hex",
                    "frame": "INVALID_HEX_DATA_HERE!",
                }
            ]
            
            for error_test in error_tests:
                print(f"\n   Тест: {error_test['name']}")
                try:
                    request = dbc_pb2.ParseFrameRequest(frame_data=error_test['frame'])
                    response = stub.ParseFrame(request)
                    print(f"   ✅ Error handled: {response.error}")
                    print(f"   ✅ Parsed: {response.parsed}")
                except grpc.RpcError as e:
                    print(f"   ✅ gRPC error handled: {e.details()}")
    
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        import traceback
        traceback.print_exc()

def test_with_real_crc():
    """Тестирование с правильным CRC16"""
    print("\n🔧 Тестирование с правильным CRC16...")
    
    try:
        # Импортируем CRC функцию
        crc_path = os.path.join(current_dir, 'src', 'dbc')
        if crc_path not in sys.path:
            sys.path.insert(0, crc_path)
        
        from crc import crc16_arc
        
        def create_valid_frame(dev_addr: int, msg_id: int, can_data: bytes) -> str:
            """Создание фрейма с правильным CRC16"""
            comm_addr = (dev_addr & 0x1F) | ((msg_id & 0x3FF) << 5)
            comm_addr_bytes = struct.pack('<H', comm_addr)
            
            padded_data = can_data + b'\x00' * (8 - len(can_data))
            payload = comm_addr_bytes + padded_data
            
            # Вычисляем правильный CRC16
            crc16 = crc16_arc(payload)
            crc16_bytes = struct.pack('<H', crc16)
            
            frame = payload + crc16_bytes
            return frame.hex().upper()
        
        # Тест с валидным CRC
        valid_frame = create_valid_frame(1, 17, struct.pack('<HHH', 42, 125, 15500))
        print(f"Frame with valid CRC: {valid_frame}")
        
        with grpc.insecure_channel('localhost:50051') as channel:
            stub = dbc_pb2_grpc.DBCParserServiceStub(channel)
            
            request = dbc_pb2.ParseFrameRequest(frame_data=valid_frame)
            response = stub.ParseFrame(request)
            
            print(f"CRC Valid: {response.crc_valid}")
            print(f"Parsed: {response.parsed}")
            if response.error:
                print(f"Error: {response.error}")
    
    except ImportError as e:
        print(f"❌ Cannot import CRC module: {e}")
        print("💡 CRC validation test skipped")
    except grpc.RpcError as e:
        print(f"❌ gRPC error in CRC test: {e.details()}")
    except Exception as e:
        print(f"❌ Unexpected error in CRC test: {e}")

if __name__ == "__main__":
    print("🚀 Запуск тестирования DBC Service...")
    
    # Проверяем, что протobуф модули загружены
    if 'dbc_pb2' not in globals() or 'dbc_pb2_grpc' not in globals():
        print("❌ Protobuf modules not loaded properly")
        sys.exit(1)
    
    test_dbc_service()
    test_with_real_crc()
    print("\n🎉 Тестирование завершено!")