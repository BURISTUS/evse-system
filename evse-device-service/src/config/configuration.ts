export default () => ({
  port: parseInt(process.env.PORT, 10) || 3001,
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1884',
    clientId: `evse-service-${Date.now()}`,
  },
  grpc: {
    dbcServiceUrl: process.env.DBC_SERVICE_URL || 'localhost:50051',
    mainBackendUrl: process.env.MAIN_BACKEND_GRPC_URL || 'localhost:50052',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
});
