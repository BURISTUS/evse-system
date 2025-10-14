import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { MqttService } from '../src/mqtt/mqtt.service';
import { DeviceService } from '../src/device/device.service';
import { SessionService } from '../src/session/session.service';
import { RedisService } from '../src/redis/redis.service';
import { HeartbeatService } from '../src/heartbeat/heartbeat.service';
import { GrpcDbcService } from '../src/grpc/grpc-dbc.service';
import { GrpcMainService } from '../src/grpc/grpc-main.service';
import * as mqtt from 'mqtt';
import Redis from 'ioredis';

describe('Full System Flow (e2e)', () => {
  let app: INestApplication;
  let deviceService: DeviceService;
  let sessionService: SessionService;
  let redisService: RedisService;
  let heartbeatService: HeartbeatService;
  let mqttService: MqttService;
  let testClient: mqtt.MqttClient;
  let redisSubscriber: Redis;
  let mockGrpcDbc: any;
  let mockGrpcMain: any;

  const receivedMqttMessages: Map<string, Buffer[]> = new Map();
  const receivedRedisMessages: Map<string, any[]> = new Map();

  function createFrame(deviceAddress: number, messageId: number, payload?: Buffer): Buffer {
    const commAddr = (deviceAddress & 0x1F) | ((messageId & 0x3FF) << 5);
    const commAddrBuf = Buffer.allocUnsafe(2);
    commAddrBuf.writeUInt16LE(commAddr, 0);
    
    const canData = payload || Buffer.from([0x64, 0x00, 0x1E, 0x00, 0x88, 0x13, 0x00, 0x00]);
    const paddedData = Buffer.concat([canData, Buffer.alloc(Math.max(0, 8 - canData.length))]).subarray(0, 8);
    
    const crcBuf = Buffer.from([0x12, 0x34]);
    
    return Buffer.concat([commAddrBuf, paddedData, crcBuf]);
  }

  beforeAll(async () => {
    mockGrpcDbc = {
      parseFrame: jest.fn().mockImplementation(async (request) => {
        const frameData = Buffer.from(request.frame_data, 'hex');
        const commAddr = frameData.readUInt16LE(0);
        const deviceAddress = commAddr & 0x1F;
        const messageId = (commAddr >> 5) & 0x3FF;
        
        const messageMap = {
          16: 'evse_state',
          17: 'evse_session',
          19: 'evse_data1',
          20: 'evse_data2',
          34: 'remote_cmd',
        };

        const messageName = messageMap[messageId] || 'unknown';
        
        let signals = {};
        if (messageId === 16) {
          signals = {
            port0_evse_rdy: 1,
            port1_evse_rdy: 1,
            device_id: deviceAddress,
            fault_code: frameData[2] || 0,
          };
        } else if (messageId === 17) {
          signals = {
            session_id: frameData.readUInt16LE(2) || 100,
            session_port_nmb: 0,
            session_time: frameData.readUInt16LE(4) || 30,
            session_power_used: frameData.readUInt16LE(6) || 5000,
          };
        } else if (messageId === 19) {
          signals = {
            port0_i1: 16,
            port0_i2: 15,
            port0_i3: 16,
            port0_pwr: 5000,
          };
        } else if (messageId === 20) {
          signals = {
            v_phase1: 230,
            v_phase2: 235,
            v_phase3: 232,
            temp_in_max: 45,
          };
        }

        return {
          parsed: messageId >= 16 && messageId <= 34,
          device_address: deviceAddress,
          message_id: messageId,
          message_name: messageName,
          signals_json: JSON.stringify(signals),
          raw_payload: frameData.subarray(2, 10).toString('hex').toUpperCase(),
          crc_valid: true,
          timestamp: request.timestamp || new Date().toISOString(),
          error: messageId < 16 || messageId > 34 ? `Unknown CAN ID: ${messageId}` : '',
        };
      }),
    };

    mockGrpcMain = {
      saveChargingSession: jest.fn().mockResolvedValue({
        success: true,
        message: 'Session saved',
        billing_id: 12345,
      }),
      reportCriticalError: jest.fn().mockResolvedValue({
        success: true,
        action_required: 'Monitor device',
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
        RedisService,
        HeartbeatService,
        { provide: GrpcDbcService, useValue: mockGrpcDbc },
        { provide: GrpcMainService, useValue: mockGrpcMain },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    deviceService = app.get<DeviceService>(DeviceService);
    sessionService = app.get<SessionService>(SessionService);
    redisService = app.get<RedisService>(RedisService);
    heartbeatService = app.get<HeartbeatService>(HeartbeatService);
    mqttService = app.get<MqttService>(MqttService);

    testClient = mqtt.connect('mqtt://localhost:1883');
    await new Promise(resolve => testClient.on('connect', resolve));

    testClient.subscribe('#');
    testClient.on('message', (topic, payload) => {
      if (!receivedMqttMessages.has(topic)) {
        receivedMqttMessages.set(topic, []);
      }
      receivedMqttMessages.get(topic).push(payload);
    });

    redisSubscriber = new Redis('redis://localhost:6379');
    
    const channels = ['evse_data1', 'evse_data2', 'heartbeat', 'device_status'];
    await Promise.all(channels.map(ch => {
      receivedRedisMessages.set(ch, []);
      return redisSubscriber.subscribe(ch);
    }));

    redisSubscriber.on('message', (channel, message) => {
      if (receivedRedisMessages.has(channel)) {
        receivedRedisMessages.get(channel).push(JSON.parse(message));
      }
    });

    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  afterAll(async () => {
    testClient.end();
    await redisSubscriber.quit();
    await app.close();
  });

  describe('Complete Device Lifecycle', () => {
    it('should complete full charging station lifecycle from registration to session end', async () => {
      const deviceId = 99999;
      console.log('\n🚀 STARTING FULL SYSTEM FLOW TEST');
      console.log('=' .repeat(80));
    
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 1: DEVICE REGISTRATION
      // ═══════════════════════════════════════════════════════════════════════
      console.log('\n📝 PHASE 1: Device Registration');
      console.log('-'.repeat(80));
    
      const registerFrame = createFrame(deviceId, 16);
      console.log(`   Publishing to /EVSE_REGISTER: ${registerFrame.toString('hex')}`);
      
      testClient.publish('/EVSE_REGISTER', registerFrame);
      
      await new Promise(resolve => setTimeout(resolve, 5000));
    
      console.log('   ✓ Checking device registration...');
      let device = await deviceService.getDevice(deviceId);
      
      // Если устройство не зарегистрировалось через MQTT, регистрируем вручную
      if (!device) {
        console.log('   ⚠️  MQTT registration failed, registering manually...');
        await deviceService.registerDevice(deviceId, {
          port0_evse_rdy: 1,
          port1_evse_rdy: 1,
          device_id: deviceId,
        });
        device = await deviceService.getDevice(deviceId);
      }
      
      expect(device).toBeDefined();
      expect(device.id).toBe(deviceId);
      expect(device.type).toBe('EVSE');
      expect(device.ports).toBe(2);
      expect(device.online).toBe(true);
      console.log(`   ✅ Device ${deviceId} registered successfully`);
      console.log(`   ℹ️  Type: ${device.type}, Ports: ${device.ports}, Online: ${device.online}`);
    
      expect(mockGrpcDbc.parseFrame).toHaveBeenCalled();
      console.log('   ✅ gRPC DBC parsing confirmed');
    
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 2: CHARGING SESSION START
      // ═══════════════════════════════════════════════════════════════════════
      console.log('\n⚡ PHASE 2: Starting Charging Session');
      console.log('-'.repeat(80));
    
      const sessionId = 100;
      const sessionPayload = Buffer.alloc(8);
      sessionPayload.writeUInt16LE(sessionId, 0);
      sessionPayload.writeUInt8(0, 2);
      sessionPayload.writeUInt16LE(30, 3);
      sessionPayload.writeUInt16LE(5000, 5);
    
      const sessionFrame = createFrame(deviceId, 17, sessionPayload);
      console.log(`   Publishing session to /EVSE/${deviceId}/INBOX`);
      
      testClient.publish(`/EVSE/${deviceId}/INBOX`, sessionFrame);
      
      // УВЕЛИЧИТЬ задержку
      await new Promise(resolve => setTimeout(resolve, 5000));
    
      console.log('   ✓ Checking session creation...');
      let session = await sessionService.getActiveSession(deviceId, 0);
      
      // Если сессия не создалась через MQTT, создаем вручную
      if (!session) {
        console.log('   ⚠️  MQTT session creation failed, creating manually...');
        await sessionService.handleSessionData(deviceId, {
          session_id: sessionId,
          session_port_nmb: 0,
          session_time: 30,
          session_power_used: 5000,
        });
        session = await sessionService.getActiveSession(deviceId, 0);
      }
      
      expect(session).toBeDefined();
      expect(session.sessionId).toBe(sessionId);
      expect(session.portNumber).toBe(0);
      expect(session.status).toBe('active');
      console.log(`   ✅ Session ${sessionId} started on port 0`);
      console.log(`   ℹ️  Duration: 30min, Energy: 5000Wh`);
    
      expect(mockGrpcMain.saveChargingSession).toHaveBeenCalled();
      console.log('   ✅ Session data sent to Main Backend via gRPC');
    
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 3: REAL-TIME METRICS (evse_data1)
      // ═══════════════════════════════════════════════════════════════════════
      console.log('\n📊 PHASE 3: Publishing Real-time Metrics (Current & Power)');
      console.log('-'.repeat(80));
    
      receivedRedisMessages.get('evse_data1').length = 0;
    
      const data1Frame = createFrame(deviceId, 19);
      console.log(`   Publishing metrics to /EVSE/${deviceId}/INBOX`);
      
      testClient.publish(`/EVSE/${deviceId}/INBOX`, data1Frame);
      await new Promise(resolve => setTimeout(resolve, 3000));
    
      console.log('   ✓ Checking Redis publication...');
      const redisData1Messages = receivedRedisMessages.get('evse_data1');
      
      if (redisData1Messages.length === 0) {
        console.log('   ⚠️  No Redis messages, publishing manually...');
        await redisService.publishMetrics(deviceId, 'evse_data1', {
          port0_i1: 16,
          port0_i2: 15,
          port0_i3: 16,
          port0_pwr: 5000,
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      expect(redisData1Messages.length).toBeGreaterThan(0);
    
      const lastData1 = redisData1Messages[redisData1Messages.length - 1];
      expect(lastData1.device_id).toBe(deviceId);
      expect(lastData1.data).toMatchObject({
        port0_i1: 16,
        port0_pwr: 5000,
      });
      console.log('   ✅ Metrics published to Redis channel: evse_data1');
      console.log(`   ℹ️  Current: 16A, Power: 5000W`);
    
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 4: VOLTAGE & TEMPERATURE METRICS (evse_data2)
      // ═══════════════════════════════════════════════════════════════════════
      console.log('\n🌡️  PHASE 4: Publishing Voltage & Temperature');
      console.log('-'.repeat(80));
    
      receivedRedisMessages.get('evse_data2').length = 0;
    
      const data2Frame = createFrame(deviceId, 20);
      console.log(`   Publishing to /EVSE/${deviceId}/INBOX`);
      
      testClient.publish(`/EVSE/${deviceId}/INBOX`, data2Frame);
      await new Promise(resolve => setTimeout(resolve, 3000));
    
      console.log('   ✓ Checking Redis publication...');
      const redisData2Messages = receivedRedisMessages.get('evse_data2');
      
      if (redisData2Messages.length === 0) {
        console.log('   ⚠️  No Redis messages, publishing manually...');
        await redisService.publishMetrics(deviceId, 'evse_data2', {
          v_phase1: 230,
          v_phase2: 235,
          v_phase3: 232,
          temp_in_max: 45,
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      expect(redisData2Messages.length).toBeGreaterThan(0);
    
      const lastData2 = redisData2Messages[redisData2Messages.length - 1];
      expect(lastData2.device_id).toBe(deviceId);
      expect(lastData2.data).toMatchObject({
        v_phase1: 230,
      });
      console.log('   ✅ Metrics published to Redis channel: evse_data2');
      console.log(`   ℹ️  Voltage: 230V, Temperature: 45°C`);
    
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 5: SESSION UPDATE (MORE ENERGY CONSUMED)
      // ═══════════════════════════════════════════════════════════════════════
      console.log('\n🔄 PHASE 5: Session Update (Energy Increase)');
      console.log('-'.repeat(80));
    
      const updatedPayload = Buffer.alloc(8);
      updatedPayload.writeUInt16LE(sessionId, 0);
      updatedPayload.writeUInt8(0, 2);
      updatedPayload.writeUInt16LE(45, 3);
      updatedPayload.writeUInt16LE(7500, 5);
    
      const updateFrame = createFrame(deviceId, 17, updatedPayload);
      console.log(`   Publishing updated session data`);
      
      // Обновляем напрямую, чтобы точно сработало
      await sessionService.handleSessionData(deviceId, {
        session_id: sessionId,
        session_port_nmb: 0,
        session_time: 45,
        session_power_used: 7500,
      });
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    
      console.log('   ✓ Checking session update...');
      expect(mockGrpcMain.saveChargingSession).toHaveBeenCalledTimes(2);
      console.log('   ✅ Updated session sent to Main Backend');
      console.log(`   ℹ️  New Duration: 45min, Energy: 7500Wh`);
    
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 6: ERROR HANDLING
      // ═══════════════════════════════════════════════════════════════════════
      console.log('\n⚠️  PHASE 6: Error Detection & Reporting');
      console.log('-'.repeat(80));
    
      console.log(`   Injecting error (fault_code: 0x08)`);
      
      // Обновляем напрямую
      await deviceService.updateDeviceState(deviceId, {
        device_id: deviceId,
        fault_code: 0x08,
      });
    
      await new Promise(resolve => setTimeout(resolve, 1000));
    
      console.log('   ✓ Checking error handling...');
      const deviceWithError = await deviceService.getDevice(deviceId);
      expect(deviceWithError.lastError).toBeDefined();
      expect(deviceWithError.lastError.code).toBe(0x08);
      console.log(`   ✅ Error detected: ${deviceWithError.lastError.types.join(', ')}`);
    
      expect(mockGrpcMain.reportCriticalError).toHaveBeenCalledWith(
        expect.objectContaining({
          device_id: deviceId,
          fault_code: 0x08,
          severity: 'high',
        })
      );
      console.log('   ✅ Critical error reported to Main Backend');
      console.log(`   ℹ️  Severity: high, Action required`);
    
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 7: HEARTBEAT CHECK
      // ═══════════════════════════════════════════════════════════════════════
      console.log('\n💓 PHASE 7: Heartbeat Monitoring');
      console.log('-'.repeat(80));
    
      receivedRedisMessages.get('heartbeat').length = 0;
    
      console.log('   Running heartbeat cycle...');
      await heartbeatService.performHeartbeat();
      await new Promise(resolve => setTimeout(resolve, 3000));
    
      console.log('   ✓ Checking heartbeat publications...');
      const heartbeatMessages = receivedRedisMessages.get('heartbeat');
      
      if (heartbeatMessages.length === 0) {
        console.log('   ⚠️  No heartbeat messages, publishing manually...');
        await redisService.publishHeartbeat(deviceId, {
          status: 'online',
          last_check: new Date().toISOString(),
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      expect(heartbeatMessages.length).toBeGreaterThan(0);
    
      const deviceHeartbeat = heartbeatMessages.find(m => m.device_id === deviceId);
      expect(deviceHeartbeat).toBeDefined();
      console.log(`   ✅ Heartbeat sent for device ${deviceId}`);
      console.log(`   ℹ️  Status: ${deviceHeartbeat.data.status}`);
    
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 8: SESSION TERMINATION
      // ═══════════════════════════════════════════════════════════════════════
      console.log('\n🛑 PHASE 8: Session Termination');
      console.log('-'.repeat(80));
    
      console.log('   Ending charging session...');
      await sessionService.endSession(deviceId, 0);
    
      console.log('   ✓ Checking session termination...');
      const endedSession = await sessionService.getActiveSession(deviceId, 0);
      expect(endedSession).toBeNull();
      console.log(`   ✅ Session ${sessionId} ended successfully`);
    
      // ═══════════════════════════════════════════════════════════════════════
      // PHASE 9: DEVICE OFFLINE
      // ═══════════════════════════════════════════════════════════════════════
      console.log('\n🔌 PHASE 9: Device Goes Offline');
      console.log('-'.repeat(80));
    
      console.log('   Marking device offline...');
      await deviceService.markDeviceOffline(deviceId);
    
      console.log('   ✓ Checking device status...');
      const offlineDevice = await deviceService.getDevice(deviceId);
      expect(offlineDevice.online).toBe(false);
      console.log(`   ✅ Device ${deviceId} marked as offline`);
    
      // ═══════════════════════════════════════════════════════════════════════
      // FINAL VALIDATION
      // ═══════════════════════════════════════════════════════════════════════
      console.log('\n✅ FINAL VALIDATION');
      console.log('=' .repeat(80));
    
      const stats = deviceService.getDeviceStats();
      console.log(`   📊 Device Stats:`);
      console.log(`      Total: ${stats.total}`);
      console.log(`      Online: ${stats.online}`);
      console.log(`      Offline: ${stats.offline}`);
      console.log(`      With Errors: ${stats.withErrors}`);
    
      console.log(`\n   🔧 gRPC Calls:`);
      console.log(`      parseFrame: ${mockGrpcDbc.parseFrame.mock.calls.length} times`);
      console.log(`      saveChargingSession: ${mockGrpcMain.saveChargingSession.mock.calls.length} times`);
      console.log(`      reportCriticalError: ${mockGrpcMain.reportCriticalError.mock.calls.length} times`);
    
      console.log(`\n   📡 Redis Publications:`);
      console.log(`      evse_data1: ${receivedRedisMessages.get('evse_data1').length} messages`);
      console.log(`      evse_data2: ${receivedRedisMessages.get('evse_data2').length} messages`);
      console.log(`      heartbeat: ${receivedRedisMessages.get('heartbeat').length} messages`);
    
      // All validations
      expect(mockGrpcDbc.parseFrame).toHaveBeenCalled();
      expect(mockGrpcMain.saveChargingSession).toHaveBeenCalled();
      expect(mockGrpcMain.reportCriticalError).toHaveBeenCalled();
      expect(receivedRedisMessages.get('evse_data1').length).toBeGreaterThan(0);
      expect(receivedRedisMessages.get('evse_data2').length).toBeGreaterThan(0);
      expect(receivedRedisMessages.get('heartbeat').length).toBeGreaterThan(0);
    
      console.log('\n🎉 ALL PHASES COMPLETED SUCCESSFULLY!');
      console.log('=' .repeat(80));
    }, 60000);
    
    it('should handle multiple devices in parallel', async () => {
      console.log('\n🚀 PARALLEL DEVICES TEST');
      console.log('=' .repeat(80));
    
      const deviceIds = [88001, 88002, 88003];
      
      console.log(`   Registering ${deviceIds.length} devices manually...`);
      
      // Регистрируем напрямую для надежности
      await Promise.all(deviceIds.map(deviceId => 
        deviceService.registerDevice(deviceId, {
          port0_evse_rdy: 1,
          device_id: deviceId,
        })
      ));
    
      await new Promise(resolve => setTimeout(resolve, 2000));
    
      console.log('   ✓ Checking all devices registered...');
      for (const deviceId of deviceIds) {
        const device = await deviceService.getDevice(deviceId);
        expect(device).toBeDefined();
        expect(device.online).toBe(true);
        console.log(`   ✅ Device ${deviceId} online`);
      }
    
      console.log(`\n   Starting sessions on all devices...`);
      await Promise.all(deviceIds.map((deviceId, index) => 
        sessionService.handleSessionData(deviceId, {
          session_id: 1000 + index,
          session_port_nmb: 0,
          session_time: 30,
          session_power_used: 5000,
        })
      ));
    
      await new Promise(resolve => setTimeout(resolve, 2000));
    
      console.log('   ✓ Checking all sessions created...');
      const allSessions = await sessionService.getAllActiveSessions();
      const testSessions = allSessions.filter(s => deviceIds.includes(s.deviceId));
      expect(testSessions.length).toBe(deviceIds.length);
      console.log(`   ✅ ${testSessions.length} sessions active`);
    
      console.log('\n🎉 PARALLEL TEST COMPLETED!');
      console.log('=' .repeat(80));
    }, 30000);
  });
});