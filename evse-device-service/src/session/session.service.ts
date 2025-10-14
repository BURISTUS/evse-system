import { Injectable, Logger } from '@nestjs/common';
import { GrpcMainService } from '../grpc/grpc-main.service';

export interface ChargingSession {
  deviceId: number;
  sessionId: number;
  portNumber: number;
  status: 'active' | 'completed' | 'error';
  startedAt: Date;
  lastUpdate: Date;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);
  private activeSessions = new Map<string, ChargingSession>();

  constructor(private grpcMainService: GrpcMainService) {}

  async handleSessionData(deviceId: number, sessionData: any): Promise<void> {
    const sessionKey = `${deviceId}-${sessionData.session_port_nmb}`;
    const existingSession = this.activeSessions.get(sessionKey);
    
    if (!existingSession) {
      const session: ChargingSession = {
        deviceId,
        sessionId: sessionData.session_id,
        portNumber: sessionData.session_port_nmb,
        status: 'active',
        startedAt: new Date(),
        lastUpdate: new Date(),
      };
      
      this.activeSessions.set(sessionKey, session);
      this.logger.log(`New charging session started: Device ${deviceId}, Port ${session.portNumber}, Session ${session.sessionId}`);
    } else {
      existingSession.lastUpdate = new Date();
    }

    await this.saveSessionToBackend(deviceId, sessionData);
  }

  private async saveSessionToBackend(deviceId: number, sessionData: any): Promise<void> {
    try {
      const sessionRequest = {
        device_id: deviceId,
        session_id: sessionData.session_id,
        port_number: sessionData.session_port_nmb,
        duration_minutes: sessionData.session_time,
        energy_consumed_wh: sessionData.session_power_used,
        status: 'active',
        timestamp: new Date().toISOString(),
      };

      const response = await this.grpcMainService.saveChargingSession(sessionRequest);
      
      if (response.success) {
        this.logger.log(`Session data saved successfully: ${response.message}`);
      } else {
        this.logger.error(`Failed to save session data: ${response.message}`);
      }

    } catch (error) {
      this.logger.error(`Error saving session data: ${error.message}`);
    }
  }

  async getActiveSession(deviceId: number, port: number): Promise<ChargingSession | null> {
    const sessionKey = `${deviceId}-${port}`;
    return this.activeSessions.get(sessionKey) || null;
  }

  async getAllActiveSessions(): Promise<ChargingSession[]> {
    return Array.from(this.activeSessions.values());
  }

  async endSession(deviceId: number, port: number): Promise<void> {
    const sessionKey = `${deviceId}-${port}`;
    const session = this.activeSessions.get(sessionKey);
    
    if (session) {
      session.status = 'completed';
      this.activeSessions.delete(sessionKey);
      this.logger.log(`Session ended: Device ${deviceId}, Port ${port}, Session ${session.sessionId}`);
    }
  }
}
