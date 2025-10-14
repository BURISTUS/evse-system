import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { MqttModule } from './mqtt/mqtt.module';
import { GrpcModule } from './grpc/grpc.module';
import { RedisModule } from './redis/redis.module';
import { DeviceModule } from './device/device.module';
import { SessionModule } from './session/session.module';
import { HeartbeatModule } from './heartbeat/heartbeat.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    MqttModule,
    GrpcModule,
    RedisModule,
    DeviceModule,
    SessionModule,
    HeartbeatModule,
  ],
})
export class AppModule {}
