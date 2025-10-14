import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

@Injectable()
export class GrpcDbcService implements OnModuleInit {
  private readonly logger = new Logger(GrpcDbcService.name);
  private dbcClient: any;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.connectToDbcService();
  }

  private async connectToDbcService() {
    const packageDefinition = protoLoader.loadSync('proto/dbc.proto', {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    const dbcServiceUrl = this.configService.get('grpc.dbcServiceUrl');

    this.dbcClient = new proto.dbc.DBCParserService(
      dbcServiceUrl,
      grpc.credentials.createInsecure()
    );

    this.logger.log(`Connected to DBC Service at ${dbcServiceUrl}`);
  }

  async parseFrame(request: { frame_data: string; timestamp?: string }): Promise<any> {
    return new Promise((resolve, reject) => {
      this.dbcClient.ParseFrame(request, (error: any, response: any) => {
        if (error) {
          this.logger.error(`DBC parse error: ${error.message}`);
          reject(error);
        } else {
          resolve(response);
        }
      });
    });
  }

  async parseBatch(frames: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const results: any[] = [];
      
      const stream = this.dbcClient.ParseBatch({ frames });
      
      stream.on('data', (response: any) => {
        results.push(response);
      });
      
      stream.on('end', () => {
        resolve(results);
      });
      
      stream.on('error', (error: any) => {
        reject(error);
      });
    });
  }
}
