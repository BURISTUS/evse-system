import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { MqttService } from '../src/mqtt/mqtt.service';
import { DeviceService } from '../src/device/device.service';
import { RedisService } from '../src/redis/redis.service';
import { SessionService } from '../src/session/session.service';
import { GrpcDbcService } from '../src/grpc/grpc-dbc.service';
import { GrpcMainService } from '../src/grpc/grpc-main.service';
import * as mqtt from 'mqtt';

describe('MQTT Integration (e2e)', () => {
  let app: INestApplication;
  let mqttService: MqttService;
  let testClient: mqtt.MqttClient;

  beforeAll(async () => {
    const mockGrpcDbc = {
      parseFrame: jest.fn().mockResolvedValue({
        parsed: true,
        device_address: 1,
        message_name: 'evse_state',
        signals_json: '{}',
      }),
    };

    const mockGrpcMain = {
      saveChargingSession: jest.fn().mockResolvedValue({ success: true }),
      reportCriticalError: jest.fn().mockResolvedValue({ success: true }),
    };

    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
        }),
      ],
      providers: [
        MqttService,
        DeviceService,
        RedisService,
        SessionService,
        { provide: GrpcDbcService, useValue: mockGrpcDbc },
        { provide: GrpcMainService, useValue: mockGrpcMain },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    
    mqttService = app.get<MqttService>(MqttService);
    testClient = mqtt.connect('mqtt://localhost:1883');
    
    await new Promise(resolve => {
      testClient.on('connect', resolve);
    });
  });

  afterAll(async () => {
    testClient.end();
    await app.close();
  });

  it('should send 12-byte frame', (done) => {
    const deviceId = 5;
    const topic = `/EVSE/${deviceId}/OUTBOX`;
    
    testClient.subscribe(topic, () => {
      mqttService.sendCommand(deviceId, {
        data_req: 0,
        req_msg_id: 0,
        charge_cmd_p0: 1,
        charge_cmd_p1: 0,
      });
    });

    testClient.once('message', (receivedTopic, payload) => {
      if (receivedTopic === topic) {
        console.log('Frame length:', payload.length);
        console.log('Frame hex:', payload.toString('hex'));
        
        expect(payload.length).toBe(12);
        
        const commAddr = payload.readUInt16LE(0);
        const devAddr = commAddr & 0x1F;
        const msgId = (commAddr >> 5) & 0x3FF;
        
        expect(devAddr).toBe(5);
        expect(msgId).toBe(34);
        
        done();
      }
    });
  }, 10000);

  it('should request device data', (done) => {
    const deviceId = 7;
    const requestedMsgId = 17;
    const topic = `/EVSE/${deviceId}/OUTBOX`;
    
    testClient.subscribe(topic, () => {
      mqttService.requestDeviceData(deviceId, requestedMsgId);
    });

    testClient.once('message', (receivedTopic, payload) => {
      if (receivedTopic === topic) {
        expect(payload.length).toBe(12);
        expect(payload[2]).toBe(1);
        expect(payload[3]).toBe(requestedMsgId);
        
        done();
      }
    });
  }, 10000);

  it('should start charging with parameters', (done) => {
    const deviceId = 9;
    const port = 0;
    const maxTime = 120;
    const maxEnergy = 50000;
    const topic = `/EVSE/${deviceId}/OUTBOX`;
    
    testClient.subscribe(topic, () => {
      mqttService.startCharging(deviceId, port, maxTime, maxEnergy);
    });

    testClient.once('message', (receivedTopic, payload) => {
      if (receivedTopic === topic) {
        expect(payload.length).toBe(12);
        expect(payload[2]).toBe(0);
        expect(payload[4]).toBe(0x11);
        
        const timeMax = payload.readUInt16LE(6);
        const energyMax = payload.readUInt16LE(8);
        
        expect(timeMax).toBe(maxTime);
        expect(energyMax).toBe(maxEnergy);
        
        done();
      }
    });
  }, 10000);

  it('should stop charging', (done) => {
    const deviceId = 11;
    const port = 0;
    const topic = `/EVSE/${deviceId}/OUTBOX`;
    
    testClient.subscribe(topic, () => {
      mqttService.stopCharging(deviceId, port);
    });

    testClient.once('message', (receivedTopic, payload) => {
      if (receivedTopic === topic) {
        expect(payload.length).toBe(12);
        expect(payload[2]).toBe(0);
        expect(payload[4]).toBe(0);
        
        done();
      }
    });
  }, 10000);

  it('should validate CRC16', (done) => {
    const deviceId = 13;
    const topic = `/EVSE/${deviceId}/OUTBOX`;
    
    testClient.subscribe(topic, () => {
      mqttService.requestDeviceData(deviceId, 17);
    });

    testClient.once('message', (receivedTopic, payload) => {
      if (receivedTopic === topic) {
        expect(payload.length).toBe(12);
        
        const commAddrAndData = payload.subarray(0, 10);
        const receivedCrc = payload.readUInt16LE(10);
        
        let calculatedCrc = 0x0000;
        for (const byte of commAddrAndData) {
          calculatedCrc ^= byte;
          for (let i = 0; i < 8; i++) {
            if (calculatedCrc & 1) {
              calculatedCrc = (calculatedCrc >> 1) ^ 0xA001;
            } else {
              calculatedCrc >>= 1;
            }
          }
        }
        calculatedCrc &= 0xFFFF;
        
        expect(receivedCrc).toBe(calculatedCrc);
        
        done();
      }
    });
  }, 10000);
});