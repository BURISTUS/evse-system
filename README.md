# EVSE System - Electric Vehicle Charging Stations Management

Complete microservices system for managing EVSE (Electric Vehicle Supply Equipment) charging stations.

## Architecture

### Microservices
- **DBC Service** (Python) - CAN frame parsing via gRPC (port 50051)
- **EVSE Device Service** (NestJS) - Device management via MQTT (port 3001)
- **Main Backend** (NestJS) - Main API and business logic (port 3000/3002)

### Infrastructure
- **PostgreSQL 15** - Primary database (port 5432/5433)
- **Redis 7** - Pub/Sub and caching (port 6379/6380)
- **Eclipse Mosquitto 2.0** - MQTT broker (port 1883/1884)

## Tech Stack

- **Backend**: Node.js 20, NestJS, Python 3.11
- **Database**: PostgreSQL 15, Redis 7
- **Communication**: MQTT, gRPC, REST, WebSocket
- **Protocols**: CAN (DBC), MQTT, HTTP/2
- **Deployment**: Docker, Docker Compose, Dokploy

## Ports Configuration

### Development Server
- `5433` - PostgreSQL (Docker, не конфликтует с 5432)
- `6380` - Redis (Docker, не конфликтует с 6379)
- `1884` - MQTT (Docker, не конфликтует с 1883)
- `9002` - MQTT WebSocket
- `3002` - Main Backend API (не конфликтует с Grafana на 3000)
- `3001` - EVSE Device Service
- `50051` - DBC Service gRPC
- `50052` - Main Backend gRPC

### Production Server
Standard ports: 5432, 6379, 1883, 9001, 3000, 3001, 50051, 50052

## Quick Start

### Prerequisites
- Docker 20.10+
- Docker Compose 2.0+
- Git

### Local Development

1. **Clone repository**
```bash
git clone https://github.com/your-username/evse-system.git
cd evse-system
```

2. **Configure environment**
```bash
cp .env.example .env
nano .env  # Edit passwords and secrets
```

3. **Start infrastructure only**
```bash
docker compose up -d postgres redis mosquitto
```

4. **Start all services**
```bash
docker compose up -d
```

5. **Check status**
```bash
docker compose ps
docker compose logs -f
```

6. **Test APIs**
```bash
# Main Backend
curl http://localhost:3002/health

# EVSE Device Service
curl http://localhost:3001/health
```

### Production Deployment with Dokploy

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed instructions.

## Project Structure
```
evse-system/
├── docker-compose.yml          # Docker Compose configuration
├── .env.example                # Environment variables template
├── mosquitto/
│   └── mosquitto.conf          # MQTT broker configuration
├── dbc-service/                # Python DBC parsing service
│   ├── Dockerfile
│   ├── src/
│   └── proto/
├── evse-device-service/        # NestJS device management
│   ├── Dockerfile
│   ├── src/
│   └── proto/
└── main-backend/               # NestJS main backend
    ├── Dockerfile
    └── src/
```

## Development Commands
```bash
# Build images
docker compose build

# Start services
docker compose up -d

# Stop services
docker compose down

# View logs
docker compose logs -f [service_name]

# Restart service
docker compose restart [service_name]

# Execute command in container
docker compose exec [service_name] sh

# Check resource usage
docker stats
```

## Database Management
```bash
# Connect to PostgreSQL
docker exec -it evse-postgres psql -U evse_user -d evse_db

# Backup database
docker exec evse-postgres pg_dump -U evse_user evse_db > backup.sql

# Restore database
docker exec -i evse-postgres psql -U evse_user evse_db < backup.sql

# Connect to Redis
docker exec -it evse-redis redis-cli
```

## MQTT Testing
```bash
# Publish message
docker exec evse-mosquitto mosquitto_pub -t test/topic -m "Hello EVSE"

# Subscribe to topic
docker exec evse-mosquitto mosquitto_sub -t test/topic
```

## Monitoring

- **Logs**: `docker compose logs -f`
- **Stats**: `docker stats`
- **Health**: Check `/health` endpoints

## Troubleshooting

### Port conflicts
Check if ports are already in use:
```bash
sudo lsof -i :3002
sudo lsof -i :5433
```

### Container won't start
Check logs:
```bash
docker compose logs [service_name]
```

### Database connection issues
Verify DATABASE_URL in .env:
```bash
echo $DATABASE_URL
docker compose exec main-backend env | grep DATABASE
```

### MQTT connection issues
Test MQTT broker:
```bash
docker exec evse-mosquitto mosquitto_pub -t test -m "test"
```

## Security Considerations

⚠️ **Before production deployment:**

1. Change all default passwords in `.env`
2. Enable MQTT authentication in `mosquitto.conf`
3. Configure firewall rules
4. Enable SSL/TLS for all services
5. Set up database backups
6. Configure log rotation
7. Enable monitoring and alerting

## License

[Your License]

## Support

For issues and questions, please open a GitHub issue.