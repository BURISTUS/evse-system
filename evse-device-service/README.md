# EVSE Device Service

NestJS сервис для управления зарядными станциями EVSE.

## Функции

- 📡 MQTT клиент для связи с устройствами
- 🔧 gRPC клиент для парсинга DBC фреймов  
- 🏢 gRPC клиент для отправки критичных данных в Main Backend
- 📤 Redis publisher для асинхронных событий
- ⏰ Heartbeat мониторинг каждые 10 минут
- 🔌 Управление зарядными сессиями

## Установка

```bash
npm install
```

## Запуск

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

## Конфигурация

Настройки в `.env` файле:

- `MQTT_BROKER_URL` - MQTT брокер
- `DBC_SERVICE_URL` - Python DBC Service  
- `MAIN_BACKEND_GRPC_URL` - Main Backend Service
- `REDIS_URL` - Redis сервер

## Тестирование

```bash
# Тест MQTT подключения
node test-service.js
```

## API

Сервис предоставляет внутренние API через:

- gRPC для критичных данных
- Redis Pub/Sub для событий
- MQTT для устройств
