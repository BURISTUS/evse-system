import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { GrpcModule } from '../grpc/grpc.module';

@Module({
  imports: [GrpcModule],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
