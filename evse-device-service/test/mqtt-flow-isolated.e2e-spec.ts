import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { MqttService } from '../src/mqtt/mqtt.service';
import { DeviceService } from '../src/device/device.service';
import { SessionService } from '../src/session/session.service';
import { RedisService } from '../src/redis/redis.service';
import { GrpcDbcService } from '../src/grpc/grpc-dbc.service';
import { GrpcMainService } from '../src/grpc/grpc-main.service';
import * as mqtt from 'mqtt';

describe('MQTT Full Flow Isolated (e2e)', () => {
  let app: INestApplication;
  let deviceService: DeviceService;
  let sessionService: SessionService;
  let testClient: mqtt.MqttClient;
  let parseFrameSpy: jest.SpyInstance;
  let saveSessionSpy: jest.SpyInstance;

  beforeAll(async () => {
    const mockGrpcDbc = {
      parseFrame: jest.fn(),
    };

    const mockGrpcMain = {
      saveChargingSession: jest.fn().mockResolvedValue({ 
        success: true,
        billing_id: 999 
      }),
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
    
    deviceService = app.get<DeviceService>(DeviceService);
    sessionService = app.get<SessionService>(SessionService);
    
    parseFrameSpy = mockGrpcDbc.parseFrame;
    saveSessionSpy = mockGrpcMain.saveChargingSession;
    
    testClient = mqtt.connect('mqtt://localhost:1883');
    
    await new Promise(resolve => {
      testClient.on('connect', resolve);
    });

    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    testClient.end();
    await app.close();
  });

  it('should complete full charging session flow', async () => {
    const deviceId = 70001;
    const port = 0;
    const sessionId = 500;

    parseFrameSpy.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 16,
      message_name: 'evse_state',
      signals_json: JSON.stringify({
        device_id: deviceId,
        port0_evse_rdy: 1,
        port0_relay_state: 0,
      }),
      crc_valid: true,
    });

    const registerFrame = Buffer.from('1002002A007D3C0000001234', 'hex');
    testClient.publish('/EVSE_REGISTER', registerFrame);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    let device = await deviceService.getDevice(deviceId);
    expect(device).toBeDefined();
    expect(device.online).toBe(true);

    parseFrameSpy.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 17,
      message_name: 'evse_session',
      signals_json: JSON.stringify({
        session_id: sessionId,
        session_port_nmb: port,
        session_time: 10,
        session_power_used: 1000,
      }),
      crc_valid: true,
    });

    const sessionStartFrame = Buffer.from('1102002A007D3C0000001234', 'hex');
    testClient.publish(`/EVSE/${deviceId}/INBOX`, sessionStartFrame);
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    let session = await sessionService.getActiveSession(deviceId, port);
    expect(session).toBeDefined();
    expect(session.sessionId).toBe(sessionId);
    expect(session.status).toBe('active');
    expect(saveSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        device_id: deviceId,
        session_id: sessionId,
        port_number: port,
      })
    );

    parseFrameSpy.mockResolvedValueOnce({
      parsed: true,
      device_address: deviceId,
      message_id: 17,
      message_name: 'evse_session',
      signals_json: JSON.stringify({
        session_id: sessionId,
        session_port_nmb: port,
        session_time: 30,
        session_power_used: 5000,
      }),
      crc_valid: true,
    });

    const sessionUpdateFrame = Buffer.from('1102002A007D3C0000001234', 'hex');
    testClient.publish(`/EVSE/${deviceId}/INBOX`, sessionUpdateFrame);
    
    await new Promise(resolve => setTimeout(resolve, 2000));

    await sessionService.endSession(deviceId, port);
    
    session = await sessionService.getActiveSession(deviceId, port);
    expect(session).toBeNull();

    const allSessions = await sessionService.getAllActiveSessions();
    const deviceSessions = allSessions.filter(s => s.deviceId === deviceId);
    expect(deviceSessions.length).toBe(0);
  });

  it('should track all parse calls', async () => {
    const deviceId = 70002;
    
    parseFrameSpy.mockClear();

    parseFrameSpy.mockResolvedValue({
      parsed: true,
      device_address: deviceId,
      message_id: 16,
      message_name: 'evse_state',
      signals_json: '{}',
      crc_valid: true,
    });

    for (let i = 0; i < 5; i++) {
      const frame = Buffer.from('1002002A007D3C0000001234', 'hex');
      testClient.publish(`/EVSE/${deviceId}/INBOX`, frame);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    expect(parseFrameSpy).toHaveBeenCalledTimes(5);
  });
});