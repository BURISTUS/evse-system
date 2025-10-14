#!/bin/bash

# Python DBC Service Setup Script
echo "🐍 Setting up Python DBC Service with gRPC..."

PROJECT_NAME="python-dbc-service"

# Создание структуры проекта
echo "📁 Creating project structure..."
mkdir -p $PROJECT_NAME/src/grpc
mkdir -p $PROJECT_NAME/src/dbc
mkdir -p $PROJECT_NAME/proto
mkdir -p $PROJECT_NAME/dbc

cd $PROJECT_NAME

# =============================================================================
# requirements.txt
# =============================================================================
echo "📝 Creating requirements.txt..."
cat > requirements.txt << 'EOF'
grpcio==1.59.0
grpcio-tools==1.59.0
cantools==39.4.5
python-dotenv==1.0.0
pydantic==2.5.0
EOF

# =============================================================================
# proto/dbc.proto
# =============================================================================
echo "📝 Creating protobuf schema..."
cat > proto/dbc.proto << 'EOF'
syntax = "proto3";

package dbc;

// Сервис для парсинга DBC фреймов
service DBCParserService {
  rpc ParseFrame(ParseFrameRequest) returns (ParseFrameResponse);
  rpc ParseBatch(ParseBatchRequest) returns (stream ParseFrameResponse);
  rpc GetDBCInfo(Empty) returns (DBCInfoResponse);
  rpc HealthCheck(Empty) returns (HealthResponse);
}

message ParseFrameRequest {
  string frame_data = 1;    // hex string 24 chars
  string timestamp = 2;     // ISO timestamp (optional)
}

message ParseFrameResponse {
  int32 device_address = 1;
  int32 message_id = 2;
  string message_name = 3;
  string signals_json = 4;  // JSON string для простоты
  string raw_payload = 5;
  bool crc_valid = 6;
  bool parsed = 7;
  string error = 8;
  string timestamp = 9;
}

message ParseBatchRequest {
  repeated ParseFrameRequest frames = 1;
}

message DBCInfoResponse {
  string dbc_file = 1;
  int32 total_messages = 2;
  string messages_json = 3;  // JSON string с mapping
  string loaded_at = 4;
}

message HealthResponse {
  string status = 1;
  bool dbc_loaded = 2;
  int32 uptime_seconds = 3;
}

message Empty {}
EOF

# =============================================================================
# src/dbc/crc.py
# =============================================================================
echo "📝 Creating CRC module..."
cat > src/dbc/crc.py << 'EOF'
def crc16_arc(data: bytes) -> int:
    """
    CRC-16/ARC алгоритм по C коду:
    width=16, poly=0x8005, init=0x0000, refin=true, refout=true, xorout=0x0000
    """
    crc = 0x0000
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001  # Рефлектированный полином
            else:
                crc >>= 1
    return crc

def validate_crc16(frame_bytes: bytes) -> bool:
    """Валидация CRC16 для 12-байтового фрейма"""
    if len(frame_bytes) != 12:
        return False
    
    payload = frame_bytes[:10]
    received_crc = int.from_bytes(frame_bytes[10:12], byteorder='little')
    calculated_crc = crc16_arc(payload)
    
    return received_crc == calculated_crc
EOF

# =============================================================================
# src/dbc/frame_parser.py
# =============================================================================
echo "📝 Creating frame parser..."
cat > src/dbc/frame_parser.py << 'EOF'
import struct
from typing import Tuple
from .crc import validate_crc16

def parse_comm_addr(comm_addr_bytes: bytes) -> Tuple[int, int]:
    """
    Парсинг COMM_ADDR по C структуре comm_addr_s:
    
    struct comm_addr_s {
        uint16_t DEV_ADDR : 5;   // Биты 4-0
        uint16_t MSG_ID : 10;    // Биты 14-5
        uint16_t RSVD : 1;       // Бит 15
    };
    """
    comm_addr_raw = struct.unpack('<H', comm_addr_bytes)[0]  # Little-endian
    
    dev_addr = comm_addr_raw & 0x1F          # Биты 4-0: DEV_ADDR (5 бит)
    msg_id = (comm_addr_raw >> 5) & 0x3FF    # Биты 14-5: MSG_ID (10 бит)
    
    return dev_addr, msg_id

def parse_frame(frame_hex: str) -> Tuple[int, int, bytes, bool, str]:
    """
    Парсинг по C структуре comm_data_s
    
    Returns: device_address, message_id, can_data, crc_valid, error
    """
    if len(frame_hex) != 24:
        return 0, 0, b'', False, "invalid_frame_size"
    
    try:
        frame_bytes = bytes.fromhex(frame_hex)
    except ValueError:
        return 0, 0, b'', False, "invalid_hex"
    
    # Парсинг по C структуре
    dev_addr, msg_id = parse_comm_addr(frame_bytes[0:2])  # comm_addr_t fid
    can_data = frame_bytes[2:10]                          # uint8_t data[8]
    crc_valid = validate_crc16(frame_bytes)               # crc16 валидация
    
    return dev_addr, msg_id, can_data, crc_valid, ""
EOF

# =============================================================================
# src/dbc/processor.py
# =============================================================================
echo "📝 Creating DBC processor..."
cat > src/dbc/processor.py << 'EOF'
import cantools
import os
import json
from typing import Dict, Any, Optional, Tuple
from datetime import datetime, timezone

class DBCProcessor:
    def __init__(self, dbc_file_path: str):
        self.dbc_file_path = dbc_file_path
        self.db: Optional[cantools.database.Database] = None
        self.loaded_at: Optional[datetime] = None
        self._create_dbc_if_not_exists()
        self.load_dbc()
    
    def _create_dbc_if_not_exists(self):
        """Создание DBC файла если не существует"""
        if os.path.exists(self.dbc_file_path):
            return
            
        dbc_content = '''VERSION ""

NS_ : 

BU_ :

BO_ 17 evse_session: 8 Vector__XXX
 SG_ session_id : 0|18@1+ (1,0) [0|262143] "" Vector__XXX
 SG_ session_time : 18|11@1+ (1,0) [0|2047] "min" Vector__XXX
 SG_ session_power_used : 29|18@1+ (1,0) [0|262143] "Wh" Vector__XXX
 SG_ session_port_nmb : 47|1@1+ (1,0) [0|1] "" Vector__XXX

BO_ 100 remote_cmd: 8 Vector__XXX
 SG_ charge_cmd_p0 : 0|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ charge_cmd_p1 : 1|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ data_req : 2|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ req_msg_id : 3|10@1+ (1,0) [0|1023] "" Vector__XXX
 SG_ cmd_charge_time_max : 13|11@1+ (1,0) [0|2047] "min" Vector__XXX
 SG_ cmd_charge_wh_max : 24|18@1+ (1,0) [0|262143] "Wh" Vector__XXX

BO_ 132 evse_state: 8 Vector__XXX
 SG_ port0_evse_rdy : 0|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ port1_evse_rdy : 1|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ mode_3phase : 2|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ port0_relay_state : 3|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ port1_relay_state : 4|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ port0_pilot_state : 5|3@1+ (1,0) [0|7] "" Vector__XXX
 SG_ port1_pilot_state : 8|3@1+ (1,0) [0|7] "" Vector__XXX
 SG_ fault_code : 11|12@1+ (1,0) [0|4095] "" Vector__XXX
 SG_ device_id : 23|32@1+ (1,0) [0|4294967295] "" Vector__XXX

BO_ 133 evse_data1: 8 Vector__XXX
 SG_ port0_i1 : 0|6@1+ (1,0) [0|63] "A" Vector__XXX
 SG_ port0_i2 : 6|6@1+ (1,0) [0|63] "A" Vector__XXX
 SG_ port0_i3 : 12|6@1+ (1,0) [0|63] "A" Vector__XXX
 SG_ port1_i1 : 18|6@1+ (1,0) [0|63] "A" Vector__XXX
 SG_ port1_i2 : 24|6@1+ (1,0) [0|63] "A" Vector__XXX
 SG_ port1_i3 : 30|6@1+ (1,0) [0|63] "A" Vector__XXX
 SG_ port0_pwr : 36|15@1+ (1,0) [0|22936] "W" Vector__XXX
 SG_ port1_pwr : 51|15@1+ (1,0) [0|22936] "W" Vector__XXX

BO_ 134 evse_data2: 8 Vector__XXX
 SG_ v_phase1 : 0|9@1+ (1,0) [0|511] "V" Vector__XXX
 SG_ v_phase2 : 9|9@1+ (1,0) [0|511] "V" Vector__XXX
 SG_ v_phase3 : 18|9@1+ (1,0) [0|511] "V" Vector__XXX
 SG_ temp_in_max : 27|8@1- (-128,0) [-128|127] "C" Vector__XXX
 SG_ port0_temp_max : 35|8@1- (-128,0) [-128|127] "C" Vector__XXX
 SG_ port1_temp_max : 43|8@1- (-128,0) [-128|127] "C" Vector__XXX
 SG_ temp_amb : 51|8@1- (-128,0) [-128|127] "C" Vector__XXX
'''
        
        os.makedirs(os.path.dirname(self.dbc_file_path), exist_ok=True)
        with open(self.dbc_file_path, 'w') as f:
            f.write(dbc_content)
        print(f"Created DBC file: {self.dbc_file_path}")
    
    def load_dbc(self):
        """Загрузка DBC файла"""
        try:
            self.db = cantools.database.load_file(self.dbc_file_path)
            self.loaded_at = datetime.now(timezone.utc)
            print(f"DBC loaded: {len(self.db.messages)} messages")
        except Exception as e:
            print(f"DBC load error: {e}")
            self.db = None
    
    def get_dbc_info(self) -> Dict[str, Any]:
        """Информация о DBC файле"""
        if not self.db:
            return {
                "dbc_file": "Not loaded",
                "total_messages": 0,
                "messages": {},
                "loaded_at": "Never"
            }
        
        messages = {}
        for msg in self.db.messages:
            messages[str(msg.frame_id)] = msg.name
        
        return {
            "dbc_file": os.path.basename(self.dbc_file_path),
            "total_messages": len(self.db.messages),
            "messages": messages,
            "loaded_at": self.loaded_at.isoformat()
        }
    
    def decode_message(self, msg_id: int, can_data: bytes) -> Tuple[Optional[str], Dict[str, Any], Optional[str]]:
        """Декодирование CAN сообщения"""
        if not self.db:
            return None, {}, "DBC not loaded"
        
        try:
            message = self.db.get_message_by_frame_id(msg_id)
            signals = message.decode(can_data)
            return message.name, dict(signals), None
        except KeyError:
            return None, {}, f"unknown_can_id: {msg_id}"
        except Exception as e:
            return None, {}, f"decode_error: {str(e)}"
EOF

# =============================================================================
# src/grpc/server.py
# =============================================================================
echo "📝 Creating gRPC server..."
cat > src/grpc/server.py << 'EOF'
import grpc
import json
import time
from concurrent import futures
from datetime import datetime, timezone
from typing import Iterator

# Генерируемые protobuf файлы
import dbc_pb2
import dbc_pb2_grpc

from ..dbc.frame_parser import parse_frame
from ..dbc.processor import DBCProcessor

class DBCParserServicer(dbc_pb2_grpc.DBCParserServiceServicer):
    def __init__(self):
        self.dbc_processor = DBCProcessor("dbc/evse_data.dbc")
        self.start_time = time.time()
    
    def ParseFrame(self, request, context):
        """Парсинг одного фрейма"""
        try:
            # Парсинг фрейма
            dev_addr, msg_id, can_data, crc_valid, error = parse_frame(request.frame_data)
            
            # Базовые данные ответа
            response = dbc_pb2.ParseFrameResponse(
                device_address=dev_addr,
                message_id=msg_id,
                message_name="",
                signals_json="{}",
                raw_payload=can_data.hex().upper(),
                crc_valid=crc_valid,
                parsed=False,
                error=error if error else ("crc_mismatch" if not crc_valid else ""),
                timestamp=request.timestamp or datetime.now(timezone.utc).isoformat()
            )
            
            # Если нет ошибок и CRC валидный - декодируем
            if not error and crc_valid:
                message_name, signals, decode_error = self.dbc_processor.decode_message(msg_id, can_data)
                response.message_name = message_name or ""
                response.signals_json = json.dumps(signals)
                response.parsed = decode_error is None
                response.error = decode_error or ""
            
            return response
            
        except Exception as e:
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(f"Internal error: {str(e)}")
            return dbc_pb2.ParseFrameResponse()
    
    def ParseBatch(self, request, context) -> Iterator[dbc_pb2.ParseFrameResponse]:
        """Batch обработка с streaming ответом"""
        try:
            for frame_request in request.frames:
                response = self.ParseFrame(frame_request, context)
                yield response
        except Exception as e:
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(f"Batch processing error: {str(e)}")
    
    def GetDBCInfo(self, request, context):
        """Информация о DBC файле"""
        try:
            info = self.dbc_processor.get_dbc_info()
            return dbc_pb2.DBCInfoResponse(
                dbc_file=info["dbc_file"],
                total_messages=info["total_messages"],
                messages_json=json.dumps(info["messages"]),
                loaded_at=info["loaded_at"]
            )
        except Exception as e:
            context.set_code(grpc.StatusCode.INTERNAL)
            context.set_details(f"Error getting DBC info: {str(e)}")
            return dbc_pb2.DBCInfoResponse()
    
    def HealthCheck(self, request, context):
        """Health check"""
        uptime = int(time.time() - self.start_time)
        dbc_loaded = self.dbc_processor.db is not None
        
        return dbc_pb2.HealthResponse(
            status="healthy" if dbc_loaded else "unhealthy",
            dbc_loaded=dbc_loaded,
            uptime_seconds=uptime
        )

def serve():
    """Запуск gRPC сервера"""
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
    dbc_pb2_grpc.add_DBCParserServiceServicer_to_server(DBCParserServicer(), server)
    
    listen_addr = '[::]:50051'
    server.add_insecure_port(listen_addr)
    
    print(f"🚀 gRPC DBC Server starting on {listen_addr}")
    server.start()
    
    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        print("🛑 Server stopping...")
        server.stop(0)

if __name__ == '__main__':
    serve()
EOF

# =============================================================================
# src/__init__.py files
# =============================================================================
echo "📝 Creating __init__.py files..."
touch src/__init__.py
touch src/dbc/__init__.py
touch src/grpc/__init__.py

# =============================================================================
# main.py
# =============================================================================
echo "📝 Creating main.py..."
cat > main.py << 'EOF'
import os
import sys

# Добавляем src в PYTHONPATH
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from src.grpc.server import serve

if __name__ == "__main__":
    print("🐍 Starting Python DBC Service with gRPC...")
    serve()
EOF

# =============================================================================
# .env
# =============================================================================
echo "📝 Creating .env file..."
cat > .env << 'EOF'
# Python DBC Service Configuration
GRPC_PORT=50051
DBC_FILE_PATH=dbc/evse_data.dbc
LOG_LEVEL=INFO
EOF

# =============================================================================
# setup.py для protobuf генерации
# =============================================================================
echo "📝 Creating setup.py..."
cat > setup.py << 'EOF'
import subprocess
import sys
import os

def generate_protobuf():
    """Генерация Python кода из protobuf"""
    print("🔧 Generating protobuf files...")
    
    # Создаем папку для сгенерированных файлов
    os.makedirs("src/grpc", exist_ok=True)
    
    # Генерация
    result = subprocess.run([
        sys.executable, "-m", "grpc_tools.protoc",
        "--proto_path=proto",
        "--python_out=src/grpc",
        "--grpc_python_out=src/grpc",
        "proto/dbc.proto"
    ], capture_output=True, text=True)
    
    if result.returncode == 0:
        print("✅ Protobuf files generated successfully")
    else:
        print(f"❌ Error generating protobuf: {result.stderr}")
        return False
    
    # Исправление imports в сгенерированных файлах
    fix_imports()
    return True

def fix_imports():
    """Исправление imports в сгенерированных файлах"""
    grpc_file = "src/grpc/dbc_pb2_grpc.py"
    if os.path.exists(grpc_file):
        with open(grpc_file, 'r') as f:
            content = f.read()
        
        content = content.replace("import dbc_pb2", "from . import dbc_pb2")
        
        with open(grpc_file, 'w') as f:
            f.write(content)
        
        print("✅ Fixed protobuf imports")

if __name__ == "__main__":
    generate_protobuf()
EOF

# =============================================================================
# Makefile для удобства
# =============================================================================
echo "📝 Creating Makefile..."
cat > Makefile << 'EOF'
.PHONY: install proto run test clean

install:
	pip install -r requirements.txt
	pip install grpcio-tools

proto:
	python setup.py

run:
	python main.py

test:
	python -m pytest tests/ -v

clean:
	rm -rf src/grpc/dbc_pb2*
	find . -type d -name "__pycache__" -exec rm -rf {} +
	find . -name "*.pyc" -delete

dev: install proto run
EOF

# =============================================================================
# Тестовый клиент
# =============================================================================
echo "📝 Creating test client..."
cat > test_client.py << 'EOF'
#!/usr/bin/env python3
import grpc
import sys
import os

# Добавляем src в PYTHONPATH
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'src'))

from src.grpc import dbc_pb2, dbc_pb2_grpc

def test_dbc_service():
    """Тестирование gRPC DBC Service"""
    
    with grpc.insecure_channel('localhost:50051') as channel:
        stub = dbc_pb2_grpc.DBCParserServiceStub(channel)
        
        print("🧪 Testing Python DBC Service via gRPC...")
        
        # Health check
        try:
            health = stub.HealthCheck(dbc_pb2.Empty())
            print(f"✅ Health: {health.status}, DBC loaded: {health.dbc_loaded}")
        except grpc.RpcError as e:
            print(f"❌ Service unavailable: {e.details()}")
            return
        
        # DBC info
        info = stub.GetDBCInfo(dbc_pb2.Empty())
        print(f"✅ DBC Info: {info.dbc_file}, Messages: {info.total_messages}")
        
        # Test frame parsing
        test_frame = dbc_pb2.ParseFrameRequest(
            frame_data="1102002A007D3C0000001234",
            timestamp="2025-01-15T10:30:45Z"
        )
        
        response = stub.ParseFrame(test_frame)
        print(f"✅ Parse Frame:")
        print(f"   Device: {response.device_address}")
        print(f"   Message: {response.message_name} (ID: {response.message_id})")
        print(f"   CRC Valid: {response.crc_valid}")
        print(f"   Parsed: {response.parsed}")
        print(f"   Signals: {response.signals_json}")
        
        if response.error:
            print(f"   Error: {response.error}")

if __name__ == "__main__":
    test_dbc_service()
EOF

chmod +x test_client.py

# =============================================================================
# Установка зависимостей
# =============================================================================
echo "📦 Installing dependencies..."

# Проверка Python
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 not found. Please install Python 3.8+ first."
    exit 1
fi

# Создание виртуального окружения
read -p "🤔 Create virtual environment? (y/n): " create_venv
if [[ $create_venv == "y" || $create_venv == "Y" ]]; then
    echo "🔧 Creating virtual environment..."
    python3 -m venv venv
    
    # Активация
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
        source venv/Scripts/activate
    else
        source venv/bin/activate
    fi
    echo "✅ Virtual environment activated"
fi

# Установка пакетов
echo "📦 Installing Python packages..."
pip install --upgrade pip
pip install -r requirements.txt
pip install grpcio-tools  # Для генерации protobuf

# Генерация protobuf файлов
echo "🔧 Generating protobuf files..."
python setup.py

echo ""
echo "🎉 Python DBC Service created successfully!"
echo ""
echo "📁 Project structure:"
echo "   $PROJECT_NAME/"
echo "   ├── src/dbc/          # DBC processing logic"
echo "   ├── src/grpc/         # gRPC server & generated files"
echo "   ├── proto/            # Protobuf schemas"
echo "   ├── main.py           # gRPC server entry point"
echo "   └── test_client.py    # Test gRPC client"
echo ""
echo "🚀 To start the service:"
echo "   cd $PROJECT_NAME"
if [[ $create_venv == "y" || $create_venv == "Y" ]]; then
echo "   source venv/bin/activate  # if not already activated"
fi
echo "   make run"
echo "   # or: python main.py"
echo ""
echo "🧪 To test the service (in another terminal):"
echo "   cd $PROJECT_NAME"
echo "   python test_client.py"
echo ""
echo "📖 gRPC Server: localhost:50051"
