#!/bin/bash

echo "🛑 Stopping Integration Test Environment"

# Stop Docker containers
docker-compose -f docker-compose.integration.yml down

# Kill Python DBC Service
pkill -f "python src/main.py"

echo "✅ All services stopped"