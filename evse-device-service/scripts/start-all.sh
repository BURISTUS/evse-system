#!/bin/bash

echo "🚀 Starting Full Integration Test Environment"
echo "=========================================="

# Start infrastructure
echo "📦 Starting Docker containers..."
docker-compose -f docker-compose.integration.yml up -d

echo "⏳ Waiting for services to be ready..."
sleep 5

# Check MQTT
echo "✓ Checking MQTT..."
mosquitto_pub -h localhost -t test -m "test" -q 1 || {
    echo "❌ MQTT not ready"
    exit 1
}

# Check Redis
echo "✓ Checking Redis..."
redis-cli ping || {
    echo "❌ Redis not ready"
    exit 1
}

# Start Python DBC Service
echo "🐍 Starting Python DBC Service..."
cd ../dbc-service
poetry run python src/main.py &
DBC_PID=$!
cd ../evse-device-service

sleep 3

# Check if DBC Service is running
lsof -i :50051 || {
    echo "❌ DBC Service not ready"
    kill $DBC_PID 2>/dev/null
    exit 1
}

echo ""
echo "✅ All services ready!"
echo ""
echo "📋 Services running:"
echo "   - MQTT:        localhost:1883"
echo "   - Redis:       localhost:6379"
echo "   - DBC Service: localhost:50051"
echo ""
echo "▶️  Run integration test:"
echo "   yarn test:integration"
echo ""
echo "🛑 To stop all services:"
echo "   ./scripts/stop-all.sh"
echo "   kill $DBC_PID"