import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { MqttService } from '../src/mqtt/mqtt.service';
import { DeviceService } from '../src/device/device.service';
import { GrpcDbcService } from '../src/grpc/grpc-dbc.service';
import { SessionService } from '../src/session/session.service';
import { GrpcMainService } from '../src/grpc/grpc-main.service';
import { RedisService } from '../src/redis/redis.service';
import * as mqtt from 'mqtt';
import { CRC16 } from 'src/mqtt/utils/crc16.util';

describe('CRC Validation and Retry (e2e)', () => {
  let app: INestApplication;
  let mqttService: MqttService;
  let deviceService: DeviceService;
  let testClient: mqtt.MqttClient;
  let mockGrpcDbc: any;
  
  const TEST_DEVICE_ID = 99999;
  let requestCount = 0;

  beforeAll(async () => {
    mockGrpcDbc = {
      parseFrame: jest.fn().mockResolvedValue({
        parsed: true,
        device_address: TEST_DEVICE_ID,
        message_id: 16,
        message_name: 'evse_state',
        signals_json: JSON.stringify({
          port0_evse_rdy: 1,
          device_id: TEST_DEVICE_ID,
        }),
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
        MqttService,
        DeviceService,
        SessionService,
        { provide: GrpcDbcService, useValue: mockGrpcDbc },
        {
          provide: GrpcMainService,
          useValue: {
            saveChargingSession: jest.fn().mockResolvedValue({ success: true }),
            reportCriticalError: jest.fn().mockResolvedValue({ success: true }),
          },
        },
        {
          provide: RedisService,
          useValue: {
            publishMetrics: jest.fn().mockResolvedValue(true),
            publishHeartbeat: jest.fn().mockResolvedValue(true),
            publishDeviceStatus: jest.fn().mockResolvedValue(true),
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    mqttService = app.get<MqttService>(MqttService);
    deviceService = app.get<DeviceService>(DeviceService);

    testClient = mqtt.connect('mqtt://localhost:1883');
    await new Promise(resolve => testClient.on('connect', resolve));
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  afterAll(async () => {
    if (testClient) {
      testClient.end();
    }
    if (app) {
      await app.close();
    }
  });

  it('should retry 3 times: 2 bad CRC, 1 good CRC', async () => {
    requestCount = 0;

    await deviceService.registerDevice(TEST_DEVICE_ID, {
      port0_evse_rdy: 1,
      device_id: TEST_DEVICE_ID,
    });

    const outboxTopic = `/EVSE/${TEST_DEVICE_ID}/OUTBOX`;
    const inboxTopic = `/EVSE/${TEST_DEVICE_ID}/INBOX`;

    testClient.subscribe(outboxTopic);
    
    testClient.on('message', (topic, payload) => {
      if (topic === outboxTopic) {
        requestCount++;
        
        console.log(`\n🔔 Request #${requestCount} received on ${topic}`);
        
        const commAddr = payload.readUInt16LE(0);
        const msgId = (commAddr >> 5) & 0x3FF;
        
        let responseFrame: Buffer;
        
        if (requestCount <= 2) {
          console.log(`   ❌ Sending BAD CRC response #${requestCount}`);
          responseFrame = createFrameWithBadCRC(TEST_DEVICE_ID, msgId);
        } else {
          console.log(`   ✅ Sending GOOD CRC response #${requestCount}`);
          responseFrame = createFrameWithGoodCRC(TEST_DEVICE_ID, msgId);
        }
        
        setTimeout(() => {
          testClient.publish(inboxTopic, responseFrame);
          console.log(`   📤 Response published to ${inboxTopic}`);
        }, 100);
      }
    });

    await new Promise(resolve => setTimeout(resolve, 500));

    console.log('\n🚀 Sending initial request...');
    await mqttService.requestDeviceData(TEST_DEVICE_ID, 16);

    await new Promise(resolve => setTimeout(resolve, 15000));

    console.log(`\n📊 Total requests made: ${requestCount}`);
    expect(requestCount).toBe(3);
    
    const device = await deviceService.getDevice(TEST_DEVICE_ID);
    expect(device).toBeDefined();
  });
});

function createFrameWithGoodCRC(deviceId: number, msgId: number): Buffer {
  const commAddr = (deviceId & 0x1F) | ((msgId & 0x3FF) << 5);
  const commAddrBytes = Buffer.allocUnsafe(2);
  commAddrBytes.writeUInt16LE(commAddr, 0);

  const canData = Buffer.from([0x03, 0x86, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);

  const crcData = Buffer.concat([commAddrBytes, canData]);
  const crc = CRC16.calculate(crcData);
  const crcBytes = Buffer.allocUnsafe(2);
  crcBytes.writeUInt16LE(crc, 0);

  const frame = Buffer.concat([commAddrBytes, canData, crcBytes]);
  
  console.log(`   ✅ Good CRC frame: ${frame.toString('hex')}`);
  console.log(`   ✅ CRC: ${CRC16.format(crc)}`);
  
  return frame;
}

function createFrameWithBadCRC(deviceId: number, msgId: number): Buffer {
  const commAddr = (deviceId & 0x1F) | ((msgId & 0x3FF) << 5);
  const commAddrBytes = Buffer.allocUnsafe(2);
  commAddrBytes.writeUInt16LE(commAddr, 0);

  const canData = Buffer.from([0x03, 0x86, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);

  const badCrc = 0xDEAD;
  const crcBytes = Buffer.allocUnsafe(2);
  crcBytes.writeUInt16LE(badCrc, 0);

  const frame = Buffer.concat([commAddrBytes, canData, crcBytes]);
  
  console.log(`   ❌ Bad CRC frame: ${frame.toString('hex')}`);
  console.log(`   ❌ Bad CRC: ${CRC16.format(badCrc)}`);
  
  return frame;
}