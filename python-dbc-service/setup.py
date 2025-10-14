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
