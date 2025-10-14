import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { DeviceService } from '../src/device/device.service';
import { GrpcMainService } from '../src/grpc/grpc-main.service';

describe('Device Service (e2e)', () => {
  let app: INestApplication;
  let deviceService: DeviceService;
  let mockGrpcMain: any;

  beforeAll(async () => {
    mockGrpcMain = {
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
        DeviceService,
        { provide: GrpcMainService, useValue: mockGrpcMain },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    
    deviceService = app.get<DeviceService>(DeviceService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockGrpcMain.reportCriticalError.mockClear();
  });

  describe('Device Registration', () => {
    it('should register EVSE device with 2 ports', async () => {
      const deviceId = 10001;
      const stateData = {
        port0_evse_rdy: 1,
        port1_evse_rdy: 1,
        device_id: deviceId,
      };

      await deviceService.registerDevice(deviceId, stateData);

      const device = await deviceService.getDevice(deviceId);
      expect(device).toBeDefined();
      expect(device.id).toBe(deviceId);
      expect(device.type).toBe('EVSE');
      expect(device.ports).toBe(2);
      expect(device.online).toBe(true);
      expect(device.registeredAt).toBeDefined();
    });

    it('should register EVSE device with 1 port', async () => {
      const deviceId = 10002;
      const stateData = {
        port0_evse_rdy: 1,
        device_id: deviceId,
      };

      await deviceService.registerDevice(deviceId, stateData);

      const device = await deviceService.getDevice(deviceId);
      expect(device.ports).toBe(1);
    });

    it('should register HOST device', async () => {
      const deviceId = 0;
      const stateData = { device_id: deviceId };

      await deviceService.registerDevice(deviceId, stateData);

      const device = await deviceService.getDevice(deviceId);
      expect(device).toBeDefined();
      expect(device.type).toBe('HOST');
    });
  });

  describe('Error Handling', () => {
    it('should handle OVERVOLTAGE error (high severity)', async () => {
      const deviceId = 10003;
      
      await deviceService.registerDevice(deviceId, { device_id: deviceId });

      const stateData = { fault_code: 0x08 };
      await deviceService.updateDeviceState(deviceId, stateData);

      const device = await deviceService.getDevice(deviceId);
      expect(device.lastError).toBeDefined();
      expect(device.lastError.code).toBe(0x08);
      expect(device.lastError.types).toContain('OVERVOLTAGE');

      expect(mockGrpcMain.reportCriticalError).toHaveBeenCalledWith(
        expect.objectContaining({
          device_id: deviceId,
          fault_code: 0x08,
          severity: 'high',
        })
      );
    });

    it('should handle OVERTEMPERATURE error (critical severity)', async () => {
      const deviceId = 10004;
      
      await deviceService.registerDevice(deviceId, { device_id: deviceId });

      const stateData = { fault_code: 0x20 };
      await deviceService.updateDeviceState(deviceId, stateData);

      expect(mockGrpcMain.reportCriticalError).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'critical',
        })
      );
    });

    it('should NOT report low severity errors', async () => {
      const deviceId = 10005;
      
      await deviceService.registerDevice(deviceId, { device_id: deviceId });

      const stateData = { fault_code: 0x01 };
      await deviceService.updateDeviceState(deviceId, stateData);

      expect(mockGrpcMain.reportCriticalError).not.toHaveBeenCalled();
    });
  });

  describe('Device State Management', () => {
    it('should update device state', async () => {
      const deviceId = 10006;
      
      await deviceService.registerDevice(deviceId, { device_id: deviceId });

      const stateData = { 
        port0_evse_rdy: 1,
        port0_relay_state: 1,
      };
      await deviceService.updateDeviceState(deviceId, stateData);

      const device = await deviceService.getDevice(deviceId);
      expect(device.online).toBe(true);
      expect(device.lastSeen).toBeDefined();
    });

    it('should mark device offline', async () => {
      const deviceId = 10007;
      
      await deviceService.registerDevice(deviceId, { device_id: deviceId });
      await deviceService.markDeviceOffline(deviceId);

      const device = await deviceService.getDevice(deviceId);
      expect(device.online).toBe(false);
    });

    it('should clear device error', async () => {
      const deviceId = 10008;
      
      await deviceService.registerDevice(deviceId, { device_id: deviceId });
      await deviceService.updateDeviceState(deviceId, { fault_code: 0x08 });
      
      const deviceWithError = await deviceService.getDevice(deviceId);
      expect(deviceWithError.lastError).toBeDefined();

      await deviceService.clearDeviceError(deviceId);

      const deviceCleared = await deviceService.getDevice(deviceId);
      expect(deviceCleared.lastError).toBeUndefined();
    });
  });

  describe('Device Queries', () => {
    beforeAll(async () => {
      await deviceService.registerDevice(20001, { device_id: 20001 });
      await deviceService.registerDevice(20002, { device_id: 20002 });
      await deviceService.markDeviceOffline(20002);
      await deviceService.updateDeviceState(20001, { fault_code: 0x08 });
    });

    it('should get all devices', async () => {
      const devices = await deviceService.getAllDevices();
      expect(Array.isArray(devices)).toBe(true);
      expect(devices.length).toBeGreaterThanOrEqual(2);
    });

    it('should get only online devices', async () => {
      const devices = await deviceService.getOnlineDevices();
      expect(devices.every(d => d.online)).toBe(true);
    });

    it('should get only offline devices', async () => {
      const devices = await deviceService.getOfflineDevices();
      expect(devices.every(d => !d.online)).toBe(true);
    });

    it('should get devices with errors', async () => {
      const devices = await deviceService.getDevicesWithErrors();
      expect(devices.every(d => d.lastError !== undefined)).toBe(true);
    });

    it('should get device stats', () => {
      const stats = deviceService.getDeviceStats();
      
      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('online');
      expect(stats).toHaveProperty('offline');
      expect(stats).toHaveProperty('withErrors');
      expect(stats).toHaveProperty('byType');
      
      expect(stats.total).toBeGreaterThan(0);
      expect(stats.total).toBe(stats.online + stats.offline);
    });
  });
});