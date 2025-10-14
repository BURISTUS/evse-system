import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const port = configService.get('port');
  
  await app.listen(port);
  
  logger.log(`🚀 EVSE Device Service running on port ${port}`);
  logger.log(`📡 MQTT: ${configService.get('mqtt.brokerUrl')}`);
  logger.log(`🔧 DBC Service: ${configService.get('grpc.dbcServiceUrl')}`);
  logger.log(`🏢 Main Backend: ${configService.get('grpc.mainBackendUrl')}`);
}
bootstrap();
