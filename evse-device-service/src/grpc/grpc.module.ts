import { Module } from '@nestjs/common';
import { GrpcDbcService } from './grpc-dbc.service';
import { GrpcMainService } from './grpc-main.service';

@Module({
  providers: [GrpcDbcService, GrpcMainService],
  exports: [GrpcDbcService, GrpcMainService],
})
export class GrpcModule {}
