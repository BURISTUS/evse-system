import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { SessionService } from '../src/session/session.service';
import { GrpcMainService } from '../src/grpc/grpc-main.service';

describe('Session Service (e2e)', () => {
  let app: INestApplication;
  let sessionService: SessionService;
  let mockGrpcMain: any;

  beforeAll(async () => {
    mockGrpcMain = {
      saveChargingSession: jest.fn().mockResolvedValue({ 
        success: true,
        message: 'Session saved',
        billing_id: 999,
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
        SessionService,
        { provide: GrpcMainService, useValue: mockGrpcMain },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    
    sessionService = app.get<SessionService>(SessionService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    mockGrpcMain.saveChargingSession.mockClear();
  });

  describe('Session Creation', () => {
    it('should create new charging session', async () => {
      const deviceId = 50001;
      const sessionData = {
        session_id: 100,
        session_port_nmb: 0,
        session_time: 30,
        session_power_used: 5000,
      };

      await sessionService.handleSessionData(deviceId, sessionData);

      const session = await sessionService.getActiveSession(deviceId, 0);
      
      expect(session).toBeDefined();
      expect(session.deviceId).toBe(deviceId);
      expect(session.sessionId).toBe(100);
      expect(session.portNumber).toBe(0);
      expect(session.status).toBe('active');
      expect(session.startedAt).toBeInstanceOf(Date);
      expect(session.lastUpdate).toBeInstanceOf(Date);
    });

    it('should save session to Main Backend via gRPC', async () => {
      const deviceId = 50002;
      const sessionData = {
        session_id: 200,
        session_port_nmb: 0,
        session_time: 15,
        session_power_used: 2500,
      };

      await sessionService.handleSessionData(deviceId, sessionData);

      expect(mockGrpcMain.saveChargingSession).toHaveBeenCalledWith(
        expect.objectContaining({
          device_id: deviceId,
          session_id: 200,
          port_number: 0,
          duration_minutes: 15,
          energy_consumed_wh: 2500,
          status: 'active',
        })
      );
    });

    it('should create session on port 1', async () => {
      const deviceId = 50003;
      const sessionData = {
        session_id: 300,
        session_port_nmb: 1,
        session_time: 45,
        session_power_used: 8000,
      };

      await sessionService.handleSessionData(deviceId, sessionData);

      const session = await sessionService.getActiveSession(deviceId, 1);
      
      expect(session).toBeDefined();
      expect(session.portNumber).toBe(1);
    });
  });

  describe('Session Updates', () => {
  it('should update existing session', async () => {
    const deviceId = 50004;
    
    const initialData = {
      session_id: 400,
      session_port_nmb: 0,
      session_time: 10,
      session_power_used: 1000,
    };
    await sessionService.handleSessionData(deviceId, initialData);

    const sessionBefore = await sessionService.getActiveSession(deviceId, 0);
    const startTime = sessionBefore.startedAt.getTime();

    await new Promise(resolve => setTimeout(resolve, 500)); // ← УВЕЛИЧИТЬ с 100 до 500

    const updatedData = {
      session_id: 400,
      session_port_nmb: 0,
      session_time: 20,
      session_power_used: 3000,
    };
    await sessionService.handleSessionData(deviceId, updatedData);

    const sessionAfter = await sessionService.getActiveSession(deviceId, 0);
    
    expect(sessionAfter.sessionId).toBe(400);
    expect(sessionAfter.startedAt.getTime()).toBe(startTime);
    
    expect(mockGrpcMain.saveChargingSession).toHaveBeenCalledTimes(2);
  });

    it('should track session updates to Backend', async () => {
      const deviceId = 50005;
      const sessionData = {
        session_id: 500,
        session_port_nmb: 0,
        session_time: 30,
        session_power_used: 5000,
      };

      await sessionService.handleSessionData(deviceId, sessionData);
      await sessionService.handleSessionData(deviceId, { 
        ...sessionData, 
        session_time: 45,
        session_power_used: 7500,
      });

      expect(mockGrpcMain.saveChargingSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('Multiple Sessions', () => {
    it('should handle sessions on different ports', async () => {
      const deviceId = 50006;

      await sessionService.handleSessionData(deviceId, {
        session_id: 600,
        session_port_nmb: 0,
        session_time: 10,
        session_power_used: 1000,
      });

      await sessionService.handleSessionData(deviceId, {
        session_id: 601,
        session_port_nmb: 1,
        session_time: 15,
        session_power_used: 2000,
      });

      const session0 = await sessionService.getActiveSession(deviceId, 0);
      const session1 = await sessionService.getActiveSession(deviceId, 1);

      expect(session0).toBeDefined();
      expect(session1).toBeDefined();
      expect(session0.sessionId).toBe(600);
      expect(session1.sessionId).toBe(601);
    });

    it('should get all active sessions', async () => {
      const deviceId1 = 50007;
      const deviceId2 = 50008;

      await sessionService.handleSessionData(deviceId1, {
        session_id: 700,
        session_port_nmb: 0,
        session_time: 10,
        session_power_used: 1000,
      });

      await sessionService.handleSessionData(deviceId2, {
        session_id: 800,
        session_port_nmb: 0,
        session_time: 20,
        session_power_used: 2000,
      });

      const sessions = await sessionService.getAllActiveSessions();

      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      
      const session700 = sessions.find(s => s.sessionId === 700);
      const session800 = sessions.find(s => s.sessionId === 800);
      
      expect(session700).toBeDefined();
      expect(session800).toBeDefined();
    });
  });

  describe('Session Termination', () => {
    it('should end active session', async () => {
      const deviceId = 50009;
      const port = 0;

      await sessionService.handleSessionData(deviceId, {
        session_id: 900,
        session_port_nmb: port,
        session_time: 30,
        session_power_used: 5000,
      });

      let session = await sessionService.getActiveSession(deviceId, port);
      expect(session).toBeDefined();

      await sessionService.endSession(deviceId, port);

      session = await sessionService.getActiveSession(deviceId, port);
      expect(session).toBeNull();
    });

    it('should change session status to completed', async () => {
      const deviceId = 50010;
      const port = 0;

      await sessionService.handleSessionData(deviceId, {
        session_id: 1000,
        session_port_nmb: port,
        session_time: 60,
        session_power_used: 10000,
      });

      await sessionService.endSession(deviceId, port);

      const allSessions = await sessionService.getAllActiveSessions();
      const endedSession = allSessions.find(
        s => s.deviceId === deviceId && s.portNumber === port
      );

      expect(endedSession).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle Backend save failure gracefully', async () => {
      mockGrpcMain.saveChargingSession.mockRejectedValueOnce(
        new Error('Backend unavailable')
      );

      const deviceId = 50011;

      await expect(
        sessionService.handleSessionData(deviceId, {
          session_id: 1100,
          session_port_nmb: 0,
          session_time: 10,
          session_power_used: 1000,
        })
      ).resolves.not.toThrow();

      // Сессия должна создаться локально даже если Backend недоступен
      const session = await sessionService.getActiveSession(deviceId, 0);
      expect(session).toBeDefined();
    });

    it('should handle invalid session data', async () => {
      const deviceId = 50012;

      await expect(
        sessionService.handleSessionData(deviceId, {} as any)
      ).resolves.not.toThrow();
    });
  });

  describe('Session Queries', () => {
    it('should return null for non-existent session', async () => {
      const session = await sessionService.getActiveSession(99999, 0);
      expect(session).toBeNull();
    });

    it('should get session by device and port', async () => {
      const deviceId = 50013;

      await sessionService.handleSessionData(deviceId, {
        session_id: 1300,
        session_port_nmb: 0,
        session_time: 25,
        session_power_used: 4000,
      });

      const session = await sessionService.getActiveSession(deviceId, 0);
      
      expect(session).toBeDefined();
      expect(session.sessionId).toBe(1300);
    });
  });
});