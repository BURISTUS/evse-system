import { Module } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service';
import { DeviceModule } from '../device/device.module';
import { MqttModule } from '../mqtt/mqtt.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    DeviceModule, 
    MqttModule,
    RedisModule,
  ],
  providers: [HeartbeatService],
})
export class HeartbeatModule {}