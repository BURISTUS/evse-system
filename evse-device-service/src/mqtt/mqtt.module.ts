import { Module } from '@nestjs/common';
import { MqttService } from './mqtt.service';
import { DeviceModule } from '../device/device.module';
import { GrpcModule } from '../grpc/grpc.module';
import { RedisModule } from '../redis/redis.module';
import { SessionModule } from '../session/session.module';

@Module({
  imports: [
    DeviceModule,
    GrpcModule,
    RedisModule,
    SessionModule,
  ],
  providers: [MqttService],
  exports: [MqttService],
})
export class MqttModule {}