import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

@Injectable()
export class GrpcMainService implements OnModuleInit {
  private readonly logger = new Logger(GrpcMainService.name);
  private mainClient: any;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.connectToMainBackend();
  }

  private async connectToMainBackend() {
    const packageDefinition = protoLoader.loadSync('proto/evse.proto', {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    const mainBackendUrl = this.configService.get('grpc.mainBackendUrl');

    this.mainClient = new proto.evse.EVSEService(
      mainBackendUrl,
      grpc.credentials.createInsecure()
    );

    this.logger.log(`Connected to Main Backend at ${mainBackendUrl}`);
  }

  async saveChargingSession(sessionData: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.mainClient.SaveChargingSession(sessionData, (error: any, response: any) => {
        if (error) {
          this.logger.error(`Failed to save session: ${error.message}`);
          reject(error);
        } else {
          resolve(response);
        }
      });
    });
  }

  async reportCriticalError(errorData: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.mainClient.ReportCriticalError(errorData, (error: any, response: any) => {
        if (error) {
          this.logger.error(`Failed to report error: ${error.message}`);
          reject(error);
        } else {
          resolve(response);
        }
      });
    });
  }
}
