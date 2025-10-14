import { Module } from '@nestjs/common';
import { DeviceService } from './device.service';
import { GrpcModule } from '../grpc/grpc.module';

@Module({
  imports: [GrpcModule], 
  providers: [DeviceService],
  exports: [DeviceService],
})
export class DeviceModule {}