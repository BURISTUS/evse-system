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

describe('MQTT Data Processing (e2e)', () => {
  let app: INestApplication;
  let deviceService: DeviceService;
  let sessionService: SessionService;
  let redisService: RedisService;
  let testClient: mqtt.MqttClient;
  let mockGrpcDbc: any;
  let mockGrpcMain: any;

  function createFrame(deviceAddress: number, messageId: number): Buffer {
    const commAddr = (deviceAddress & 0x1F) | ((messageId & 0x3FF) << 5);
    const commAddrBuf = Buffer.allocUnsafe(2);
    commAddrBuf.writeUInt16LE(commAddr, 0);
    
    const canData = Buffer.from([0x00, 0x2A, 0x00, 0x7D, 0x3C, 0x00, 0x00, 0x00]);
    const crcBuf = Buffer.from([0x12, 0x34]);
    
    return Buffer.concat([commAddrBuf, canData, crcBuf]);
  }

  beforeAll(async () => {
    mockGrpcDbc = {
      parseFrame: jest.fn(),
    };

    mockGrpcMain = {
      saveChargingSession: jest.fn().mockResolvedValue({ 
        success: true, 
        message: 'Session saved',
        billing_id: 123 
      }),
      reportCriticalError: jest.fn().mockResolvedValue({ 
        success: true,
        action_required: 'Monitor device' 
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
        RedisService,
        SessionService,
        { provide: GrpcDbcService, useValue: mockGrpcDbc },
        { provide: GrpcMainService, useValue: mockGrpcMain },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    
    deviceService = app.get<DeviceService>(DeviceService);
    sessionService = app.get<SessionService>(SessionService);
    redisService = app.get<RedisService>(RedisService);
    
    testClient = mqtt.connect('mqtt://localhost:1883');
    
    await new Promise(resolve => {
      testClient.on('connect', resolve);
    });

    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  afterAll(async () => {
    testClient.end();
    await app.close();
  });

  beforeEach(() => {
    mockGrpcDbc.parseFrame.mockClear();
    mockGrpcMain.saveChargingSession.mockClear();
    mockGrpcMain.reportCriticalError.mockClear();
  });

  it('should process evse_state registration', async () => {
    const deviceId = 50001;
    
    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 16,
      message_name: 'evse_state',
      signals_json: JSON.stringify({
        port0_evse_rdy: 1,
        port1_evse_rdy: 1,
        device_id: deviceId,
        fault_code: 0,
      }),
      crc_valid: true,
      timestamp: new Date().toISOString(),
    });

    const registerFrame = createFrame(deviceId, 16);
    
    testClient.publish('/EVSE_REGISTER', registerFrame);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    expect(mockGrpcDbc.parseFrame).toHaveBeenCalledTimes(1);
    
    const device = await deviceService.getDevice(deviceId);
    expect(device).toBeDefined();
    expect(device.id).toBe(deviceId);
    expect(device.type).toBe('EVSE');
    expect(device.ports).toBe(2);
    expect(device.online).toBe(true);
  });

  it('should process evse_session data', async () => {
    const deviceId = 50002;
    
    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 16,
      message_name: 'evse_state',
      signals_json: JSON.stringify({
        port0_evse_rdy: 1,
        device_id: deviceId,
      }),
      crc_valid: true,
    });

    testClient.publish('/EVSE_REGISTER', createFrame(deviceId, 16));
    
    await new Promise(resolve => setTimeout(resolve, 3000));

    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 17,
      message_name: 'evse_session',
      signals_json: JSON.stringify({
        session_id: 100,
        session_port_nmb: 0,
        session_time: 30,
        session_power_used: 5000,
      }),
      crc_valid: true,
      timestamp: new Date().toISOString(),
    });

    const sessionFrame = createFrame(deviceId, 17);
    
    testClient.publish(`/EVSE/${deviceId}/INBOX`, sessionFrame);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    expect(mockGrpcDbc.parseFrame).toHaveBeenCalledTimes(2);
    expect(mockGrpcMain.saveChargingSession).toHaveBeenCalled();
    
    const session = await sessionService.getActiveSession(deviceId, 0);
    expect(session).toBeDefined();
    expect(session.sessionId).toBe(100);
    expect(session.portNumber).toBe(0);
  });

  it('should process evse_data1 metrics', async () => {
    const deviceId = 50003;
    
    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 16,
      message_name: 'evse_state',
      signals_json: JSON.stringify({
        port0_evse_rdy: 1,
        device_id: deviceId,
      }),
      crc_valid: true,
    });

    testClient.publish('/EVSE_REGISTER', createFrame(deviceId, 16));
    
    await new Promise(resolve => setTimeout(resolve, 3000));

    const redisPublishSpy = jest.spyOn(redisService, 'publishMetrics');

    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 19,
      message_name: 'evse_data1',
      signals_json: JSON.stringify({
        port0_i1: 16,
        port0_i2: 15,
        port0_i3: 16,
        port0_pwr: 5000,
      }),
      crc_valid: true,
      timestamp: new Date().toISOString(),
    });

    const data1Frame = createFrame(deviceId, 19);
    
    testClient.publish(`/EVSE/${deviceId}/INBOX`, data1Frame);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    expect(mockGrpcDbc.parseFrame).toHaveBeenCalledTimes(2);
    expect(redisPublishSpy).toHaveBeenCalledWith(
      deviceId,
      'evse_data1',
      expect.objectContaining({
        port0_i1: 16,
        port0_pwr: 5000,
      })
    );
  });

  it('should process evse_data2 metrics', async () => {
    const deviceId = 50004;
    
    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 16,
      message_name: 'evse_state',
      signals_json: JSON.stringify({
        port0_evse_rdy: 1,
        device_id: deviceId,
      }),
      crc_valid: true,
    });

    testClient.publish('/EVSE_REGISTER', createFrame(deviceId, 16));
    
    await new Promise(resolve => setTimeout(resolve, 3000));

    const redisPublishSpy = jest.spyOn(redisService, 'publishMetrics');

    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 20,
      message_name: 'evse_data2',
      signals_json: JSON.stringify({
        v_phase1: 230,
        v_phase2: 235,
        v_phase3: 232,
        temp_in_max: 45,
      }),
      crc_valid: true,
      timestamp: new Date().toISOString(),
    });

    const data2Frame = createFrame(deviceId, 20);
    
    testClient.publish(`/EVSE/${deviceId}/INBOX`, data2Frame);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    expect(mockGrpcDbc.parseFrame).toHaveBeenCalledTimes(2);
    expect(redisPublishSpy).toHaveBeenCalledWith(
      deviceId,
      'evse_data2',
      expect.objectContaining({
        v_phase1: 230,
      })
    );
  });

  it('should handle device errors', async () => {
    const deviceId = 50005;
    
    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 16,
      message_name: 'evse_state',
      signals_json: JSON.stringify({
        port0_evse_rdy: 1,
        device_id: deviceId,
      }),
      crc_valid: true,
    });

    testClient.publish('/EVSE_REGISTER', createFrame(deviceId, 16));
    
    await new Promise(resolve => setTimeout(resolve, 3000));

    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 16,
      message_name: 'evse_state',
      signals_json: JSON.stringify({
        device_id: deviceId,
        fault_code: 0x08,
      }),
      crc_valid: true,
      timestamp: new Date().toISOString(),
    });

    const errorFrame = createFrame(deviceId, 16);
    
    testClient.publish(`/EVSE/${deviceId}/INBOX`, errorFrame);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    expect(mockGrpcDbc.parseFrame).toHaveBeenCalledTimes(2);
    expect(mockGrpcMain.reportCriticalError).toHaveBeenCalledWith(
      expect.objectContaining({
        device_id: deviceId,
        fault_code: 0x08,
      })
    );

    const device = await deviceService.getDevice(deviceId);
    expect(device.lastError).toBeDefined();
    expect(device.lastError.code).toBe(0x08);
  });

  it('should update device state', async () => {
    const deviceId = 50006;
    
    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 16,
      message_name: 'evse_state',
      signals_json: JSON.stringify({
        port0_evse_rdy: 1,
        device_id: deviceId,
      }),
      crc_valid: true,
    });

    testClient.publish('/EVSE_REGISTER', createFrame(deviceId, 16));
    
    await new Promise(resolve => setTimeout(resolve, 3000));

    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 16,
      message_name: 'evse_state',
      signals_json: JSON.stringify({
        device_id: deviceId,
        port0_evse_rdy: 1,
        port0_relay_state: 1,
        fault_code: 0,
      }),
      crc_valid: true,
      timestamp: new Date().toISOString(),
    });

    const stateFrame = createFrame(deviceId, 16);
    
    testClient.publish(`/EVSE/${deviceId}/INBOX`, stateFrame);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    expect(mockGrpcDbc.parseFrame).toHaveBeenCalledTimes(2);
    
    const device = await deviceService.getDevice(deviceId);
    expect(device).toBeDefined();
    expect(device.online).toBe(true);
  });

  it('should verify gRPC mock was called with correct data', async () => {
    const deviceId = 50007;

    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 16,
      message_name: 'evse_state',
      signals_json: JSON.stringify({
        port0_evse_rdy: 1,
        device_id: deviceId,
      }),
      crc_valid: true,
    });

    testClient.publish('/EVSE_REGISTER', createFrame(deviceId, 16));
    
    await new Promise(resolve => setTimeout(resolve, 3000));

    mockGrpcDbc.parseFrame.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 17,
      message_name: 'evse_session',
      signals_json: JSON.stringify({
        session_id: 200,
        session_port_nmb: 1,
      }),
      crc_valid: true,
    });

    const testFrame = createFrame(deviceId, 17);
    
    testClient.publish(`/EVSE/${deviceId}/INBOX`, testFrame);
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    expect(mockGrpcDbc.parseFrame).toHaveBeenCalledTimes(2);
    expect(mockGrpcDbc.parseFrame).toHaveBeenLastCalledWith(
      expect.objectContaining({
        frame_data: testFrame.toString('hex').toUpperCase(),
      })
    );
  });

  it('should handle multiple devices simultaneously', async () => {
    const devices = [60001, 60002, 60003];

    for (const deviceId of devices) {
      mockGrpcDbc.parseFrame.mockResolvedValueOnce({
        parsed: true,
        device_address: deviceId,
        message_id: 16,
        message_name: 'evse_state',
        signals_json: JSON.stringify({
          port0_evse_rdy: 1,
          device_id: deviceId,
        }),
        crc_valid: true,
      });

      const frame = createFrame(deviceId, 16);
      testClient.publish('/EVSE_REGISTER', frame);
    }

    await new Promise(resolve => setTimeout(resolve, 4000));

    for (const deviceId of devices) {
      mockGrpcDbc.parseFrame.mockResolvedValueOnce({
        parsed: true,
        device_address: deviceId,
        message_id: 16,
        message_name: 'evse_state',
        signals_json: JSON.stringify({
          device_id: deviceId,
          fault_code: 0,
        }),
        crc_valid: true,
      });

      const frame = createFrame(deviceId, 16);
      testClient.publish(`/EVSE/${deviceId}/INBOX`, frame);
    }

    await new Promise(resolve => setTimeout(resolve, 4000));

    for (const deviceId of devices) {
      const device = await deviceService.getDevice(deviceId);
      expect(device).toBeDefined();
      expect(device.online).toBe(true);
    }
  });
});