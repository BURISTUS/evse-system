import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { RedisService } from '../src/redis/redis.service';
import Redis from 'ioredis';

describe('Redis Service (e2e)', () => {
  let app: INestApplication;
  let redisService: RedisService;
  let subscriberClient: Redis;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
        }),
      ],
      providers: [RedisService],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    
    redisService = app.get<RedisService>(RedisService);

    // Создаем отдельного subscriber для проверки публикаций
    subscriberClient = new Redis('redis://localhost:6379');
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    await subscriberClient.quit();
    await app.close();
  });

  describe('Connection', () => {
    it('should be connected to Redis', async () => {
      const connected = await redisService.isConnected();
      expect(connected).toBe(true);
    });

    it('should have ready connection status', () => {
      const status = redisService.getConnectionStatus();
      expect(status).toBe('ready');
    });
  });

  describe('Metrics Publishing', () => {
    it('should publish evse_data1 metrics to Redis', async () => {
      const deviceId = 40001;
      const channel = 'evse_data1';
      const metricsData = {
        port0_i1: 16,
        port0_i2: 15,
        port0_i3: 16,
        port0_pwr: 5000,
      };

      const receivedMessages = [];

      subscriberClient.subscribe(channel);
      subscriberClient.on('message', (receivedChannel, message) => {
        if (receivedChannel === channel) {
          receivedMessages.push(JSON.parse(message));
        }
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      await redisService.publishMetrics(deviceId, channel, metricsData);

      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(receivedMessages.length).toBeGreaterThan(0);
      
      const lastMessage = receivedMessages[receivedMessages.length - 1];
      expect(lastMessage.device_id).toBe(deviceId);
      expect(lastMessage.data).toMatchObject(metricsData);
      expect(lastMessage.timestamp).toBeDefined();
    });

    it('should publish evse_data2 metrics to Redis', async () => {
      const deviceId = 40002;
      const channel = 'evse_data2';
      const metricsData = {
        v_phase1: 230,
        v_phase2: 235,
        v_phase3: 232,
        temp_in_max: 45,
      };

      const receivedMessages = [];

      subscriberClient.subscribe(channel);
      subscriberClient.on('message', (receivedChannel, message) => {
        if (receivedChannel === channel) {
          receivedMessages.push(JSON.parse(message));
        }
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      await redisService.publishMetrics(deviceId, channel, metricsData);

      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(receivedMessages.length).toBeGreaterThan(0);
      expect(receivedMessages[0].data.v_phase1).toBe(230);
    });
  });

  describe('Heartbeat Publishing', () => {
    it('should publish heartbeat with online status', async () => {
      const deviceId = 40003;
      const channel = 'heartbeat';
      const heartbeatData = {
        status: 'online',
        last_check: new Date().toISOString(),
      };

      const receivedMessages = [];

      subscriberClient.subscribe(channel);
      subscriberClient.on('message', (receivedChannel, message) => {
        if (receivedChannel === channel) {
          receivedMessages.push(JSON.parse(message));
        }
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      await redisService.publishHeartbeat(deviceId, heartbeatData);

      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(receivedMessages.length).toBeGreaterThan(0);
      
      const lastMessage = receivedMessages[receivedMessages.length - 1];
      expect(lastMessage.device_id).toBe(deviceId);
      expect(lastMessage.data.status).toBe('online');
    });

    it('should publish heartbeat with offline status', async () => {
      const deviceId = 40004;
      const heartbeatData = {
        status: 'offline',
        error: 'Timeout',
        last_check: new Date().toISOString(),
      };

      await expect(
        redisService.publishHeartbeat(deviceId, heartbeatData)
      ).resolves.not.toThrow();
    });
  });

  describe('Device Status Publishing', () => {
    it('should publish device status', async () => {
      const deviceId = 40005;
      const channel = 'device_status';
      const statusData = {
        online: true,
        error: null,
      };

      const receivedMessages = [];

      subscriberClient.subscribe(channel);
      subscriberClient.on('message', (receivedChannel, message) => {
        if (receivedChannel === channel) {
          receivedMessages.push(JSON.parse(message));
        }
      });

      await new Promise(resolve => setTimeout(resolve, 500));

      await redisService.publishDeviceStatus(deviceId, statusData);

      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(receivedMessages.length).toBeGreaterThan(0);
      expect(receivedMessages[0].device_id).toBe(deviceId);
      expect(receivedMessages[0].status.online).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle publish errors gracefully', async () => {
      const deviceId = 40006;
      const invalidData = { circular: {} };
      invalidData.circular = invalidData; // Создаем циклическую ссылку

      await expect(
        redisService.publishMetrics(deviceId, 'test_channel', invalidData)
      ).rejects.toThrow();
    });
  });

  describe('High Throughput', () => {
    it('should handle multiple rapid publishes', async () => {
      const deviceId = 40007;
      const promises = [];

      for (let i = 0; i < 10; i++) {
        promises.push(
          redisService.publishMetrics(deviceId, 'evse_data1', {
            port0_pwr: 5000 + i,
          })
        );
      }

      await expect(Promise.all(promises)).resolves.not.toThrow();
    });
  });
});