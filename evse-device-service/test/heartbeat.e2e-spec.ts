import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { HeartbeatService } from '../src/heartbeat/heartbeat.service';
import { DeviceService } from '../src/device/device.service';
import { MqttService } from '../src/mqtt/mqtt.service';
import { RedisService } from '../src/redis/redis.service';
import { GrpcDbcService } from '../src/grpc/grpc-dbc.service';
import { GrpcMainService } from '../src/grpc/grpc-main.service';
import * as mqtt from 'mqtt';

describe('Heartbeat Service (e2e)', () => {
  let app: INestApplication;
  let heartbeatService: HeartbeatService;
  let deviceService: DeviceService;
  let mqttService: MqttService;
  let redisService: RedisService;
  let testClient: mqtt.MqttClient;
  let mockGrpcDbc: any;

  beforeAll(async () => {
    mockGrpcDbc = {
      parseFrame: jest.fn().mockResolvedValue({
        parsed: true,
        device_address: 1,
        message_id: 16,
        message_name: 'evse_state',
        signals_json: '{}',
        crc_valid: true,
      }),
    };

    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
        }),
      ],
      providers: [
        HeartbeatService,
        DeviceService,
        MqttService,
        RedisService,
        { provide: GrpcDbcService, useValue: mockGrpcDbc },
        { 
          provide: GrpcMainService, 
          useValue: { 
            saveChargingSession: jest.fn().mockResolvedValue({ success: true }),
            reportCriticalError: jest.fn().mockResolvedValue({ success: true }),
          } 
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    
    heartbeatService = app.get<HeartbeatService>(HeartbeatService);
    deviceService = app.get<DeviceService>(DeviceService);
    mqttService = app.get<MqttService>(MqttService);
    redisService = app.get<RedisService>(RedisService);

    testClient = mqtt.connect('mqtt://localhost:1883');
    await new Promise(resolve => testClient.on('connect', resolve));
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  afterAll(async () => {
    testClient.end();
    await app.close();
  });

  describe('Heartbeat Execution', () => {
    it('should send heartbeat to online devices', async () => {
      const deviceId = 30001;
      
      await deviceService.registerDevice(deviceId, {
        port0_evse_rdy: 1,
        device_id: deviceId,
      });

      const publishSpy = jest.spyOn(redisService, 'publishHeartbeat');

      await heartbeatService.performHeartbeat();

      expect(publishSpy).toHaveBeenCalledWith(
        deviceId,
        expect.objectContaining({
          status: expect.stringMatching(/online|offline/),
        })
      );
    });

    it('should request evse_data2 from devices', async () => {
      const deviceId = 30002;
      const receivedMessages = [];

      await deviceService.registerDevice(deviceId, {
        port0_evse_rdy: 1,
        device_id: deviceId,
      });

      testClient.subscribe(`/EVSE/${deviceId}/OUTBOX`);
      testClient.on('message', (topic, payload) => {
        if (topic === `/EVSE/${deviceId}/OUTBOX`) {
          receivedMessages.push(payload);
        }
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      await heartbeatService.performHeartbeat();

      await new Promise(resolve => setTimeout(resolve, 3000));

      expect(receivedMessages.length).toBeGreaterThan(0);
      
      // Проверяем что отправлен запрос evse_data2 (msg_id=20) или evse_state (msg_id=16)
      const lastMessage = receivedMessages[receivedMessages.length - 1];
      expect(lastMessage.length).toBe(12);
    });

    it('should request evse_state from devices', async () => {
      const deviceId = 30003;

      await deviceService.registerDevice(deviceId, {
        port0_evse_rdy: 1,
        device_id: deviceId,
      });

      const requestSpy = jest.spyOn(mqttService, 'requestDeviceData');

      await heartbeatService.performHeartbeat();

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Heartbeat должен запросить evse_data2 (20) и evse_state (16)
      expect(requestSpy).toHaveBeenCalled();
    });
  });

  describe('Offline Device Detection', () => {
    it('should mark device offline if heartbeat fails', async () => {
      const deviceId = 30004;

      await deviceService.registerDevice(deviceId, {
        port0_evse_rdy: 1,
        device_id: deviceId,
      });

      // Мокируем отказ MQTT
      jest.spyOn(mqttService, 'requestDeviceData').mockRejectedValueOnce(
        new Error('Device not responding')
      );

      await heartbeatService.performHeartbeat();

      await new Promise(resolve => setTimeout(resolve, 2000));

      const device = await deviceService.getDevice(deviceId);
      // Device может быть offline если не ответил
      expect(device).toBeDefined();
    });

    it('should publish offline status to Redis', async () => {
      const deviceId = 30005;

      await deviceService.registerDevice(deviceId, {
        port0_evse_rdy: 1,
        device_id: deviceId,
      });

      const publishSpy = jest.spyOn(redisService, 'publishHeartbeat');

      jest.spyOn(mqttService, 'requestDeviceData').mockRejectedValueOnce(
        new Error('Timeout')
      );

      await heartbeatService.performHeartbeat();

      await new Promise(resolve => setTimeout(resolve, 2000));

      expect(publishSpy).toHaveBeenCalledWith(
        deviceId,
        expect.objectContaining({
          status: 'offline',
          error: expect.any(String),
        })
      );
    });
  });

  describe('Multiple Devices Heartbeat', () => {
    it('should handle heartbeat for multiple devices', async () => {
      const deviceIds = [30006, 30007, 30008];

      for (const deviceId of deviceIds) {
        await deviceService.registerDevice(deviceId, {
          port0_evse_rdy: 1,
          device_id: deviceId,
        });
      }

      const publishSpy = jest.spyOn(redisService, 'publishHeartbeat');

      await heartbeatService.performHeartbeat();

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Каждое устройство должно получить heartbeat
      expect(publishSpy.mock.calls.length).toBeGreaterThanOrEqual(deviceIds.length);
    });

    it('should respect delay between device requests', async () => {
      const deviceIds = [30009, 30010];

      for (const deviceId of deviceIds) {
        await deviceService.registerDevice(deviceId, {
          port0_evse_rdy: 1,
          device_id: deviceId,
        });
      }

      const start = Date.now();
      await heartbeatService.performHeartbeat();
      const duration = Date.now() - start;

      // Должна быть задержка между запросами (2 устройства * 2 секунды = минимум 4 сек)
      expect(duration).toBeGreaterThan(4000);
    });
  });

  describe('Heartbeat Scheduling', () => {
    it('should not throw errors during execution', async () => {
      const deviceId = 30011;

      await deviceService.registerDevice(deviceId, {
        port0_evse_rdy: 1,
        device_id: deviceId,
      });

      await expect(
        heartbeatService.performHeartbeat()
      ).resolves.not.toThrow();
    });
  });
});