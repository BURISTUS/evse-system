import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private publisher: Redis;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    if (this.publisher) {
      this.publisher.disconnect();
    }
  }

  private async connect() {
    const redisUrl = this.configService.get('redis.url');
    
    this.publisher = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      connectTimeout: 60000,
      lazyConnect: true,
      enableReadyCheck: false,
      retryStrategy: (times) => {
        const delay = Math.min(100 + times * 50, 2000);
        return delay;
      },
      reconnectOnError: (err) => {
        const targetError = 'READONLY';
        return err.message.includes(targetError);
      },
    });

    this.publisher.on('connect', () => {
      this.logger.log(`Connected to Redis: ${redisUrl}`);
    });

    this.publisher.on('error', (error) => {
      this.logger.error(`Redis error: ${error.message}`);
    });

    this.publisher.on('reconnecting', () => {
      this.logger.warn('Reconnecting to Redis...');
    });

    try {
      await this.publisher.connect();
      await this.publisher.ping();
      this.logger.log('Redis connection established');
    } catch (error) {
      this.logger.error(`Failed to connect to Redis: ${error.message}`);
      throw error;
    }
  }

  async publishMetrics(deviceId: number, channel: string, data: any): Promise<void> {
    const message = {
      device_id: deviceId,
      data,
      timestamp: new Date().toISOString(),
    };
  
    try {
      await this.publisher.publish(channel, JSON.stringify(message));
      this.logger.debug(`Published to ${channel} for device ${deviceId}`);
    } catch (error) {
      this.logger.error(`Failed to publish to ${channel}: ${error.message}`);
      throw error;
    }
  }

  async publishHeartbeat(deviceId: number, data: any): Promise<void> {
    const message = {
      device_id: deviceId,
      data,
      timestamp: new Date().toISOString(),
    };
  
    try {
      await this.publisher.publish('heartbeat', JSON.stringify(message));
      this.logger.debug(`Published heartbeat for device ${deviceId}`);
    } catch (error) {
      this.logger.error(`Failed to publish heartbeat: ${error.message}`);
      throw error;
    }
  }
  
  async publishDeviceStatus(deviceId: number, status: any): Promise<void> {
    const message = {
      device_id: deviceId,
      status,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.publisher.publish('device_status', JSON.stringify(message));
      this.logger.debug(`Published device status for ${deviceId}`);
    } catch (error) {
      this.logger.error(`Failed to publish device status: ${error.message}`);
      throw error;
    }
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.publisher.ping();
      return true;
    } catch (error) {
      return false;
    }
  }

  getConnectionStatus(): string {
    return this.publisher.status;
  }
}