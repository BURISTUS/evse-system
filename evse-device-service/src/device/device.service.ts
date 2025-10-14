import { Injectable, Logger } from '@nestjs/common';
import { GrpcMainService } from '../grpc/grpc-main.service';

export interface Device {
  id: number;
  type: 'EVSE' | 'HOST';
  online: boolean;
  ports: number;
  lastSeen: Date;
  registeredAt: Date;
  hostId?: number;
  lastError?: {
    code: number;
    types: string[];
    timestamp: Date;
  };
}

@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);
  private devices = new Map<number, Device>();

  constructor(private grpcMainService: GrpcMainService) {}

  async registerDevice(deviceId: number, stateData: any): Promise<void> {
    const device: Device = {
      id: deviceId,
      type: deviceId === 0 ? 'HOST' : 'EVSE',
      online: true,
      ports: this.detectPortCount(stateData),
      lastSeen: new Date(),
      registeredAt: new Date(),
    };

    this.devices.set(deviceId, device);
    this.logger.log(`Device registered: ${deviceId} (${device.type}, ${device.ports} ports)`);
  }

  async updateDeviceState(deviceId: number, stateData: any): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      this.logger.warn(`Unknown device: ${deviceId}, registering...`);
      await this.registerDevice(deviceId, stateData);
      return;
    }

    device.lastSeen = new Date();
    device.online = true;
    
    if (stateData.fault_code && stateData.fault_code > 0) {
      await this.handleDeviceError(deviceId, stateData.fault_code);
    }
    
    this.logger.debug(`Device ${deviceId} state updated`);
  }

  async getDevice(deviceId: number): Promise<Device | null> {
    return this.devices.get(deviceId) || null;
  }

  async getAllDevices(): Promise<Device[]> {
    return Array.from(this.devices.values());
  }

  async markDeviceOffline(deviceId: number): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device) {
      device.online = false;
      this.logger.warn(`Device ${deviceId} marked offline`);
    }
  }

  private detectPortCount(stateData: any): number {
    const port0Ready = stateData.port0_evse_rdy !== undefined;
    const port1Ready = stateData.port1_evse_rdy !== undefined;
    
    return port0Ready && port1Ready ? 2 : 1;
  }

  private async handleDeviceError(deviceId: number, faultCode: number): Promise<void> {
    this.logger.error(`Device ${deviceId} reported error code: 0x${faultCode.toString(16)}`);
    
    const errorTypes = this.parseErrorCode(faultCode);
    const severity = this.determineSeverity(faultCode);
    
    const device = this.devices.get(deviceId);
    if (device) {
      device.lastError = {
        code: faultCode,
        types: errorTypes,
        timestamp: new Date(),
      };
    }
    
    this.logger.error(`Device ${deviceId} errors: ${errorTypes.join(', ')} (severity: ${severity})`);
    
    if (severity === 'critical' || severity === 'high') {
      try {
        await this.reportCriticalError(deviceId, errorTypes, faultCode, severity);
      } catch (error) {
        this.logger.error(`Failed to report critical error to backend: ${error.message}`);
      }
    }
  }

  private parseErrorCode(faultCode: number): string[] {
    const errors: string[] = [];
    
    if (faultCode & 0x01) errors.push('OVERCURRENT_L1');
    if (faultCode & 0x02) errors.push('OVERCURRENT_L2');
    if (faultCode & 0x04) errors.push('OVERCURRENT_L3');
    if (faultCode & 0x08) errors.push('OVERVOLTAGE');
    if (faultCode & 0x10) errors.push('UNDERVOLTAGE');
    if (faultCode & 0x20) errors.push('OVERTEMPERATURE');
    if (faultCode & 0x40) errors.push('GROUND_FAULT');
    if (faultCode & 0x80) errors.push('COMMUNICATION_ERROR');
    if (faultCode & 0x100) errors.push('CONTACTOR_FAULT');
    if (faultCode & 0x200) errors.push('PILOT_FAULT');
    if (faultCode & 0x400) errors.push('EMERGENCY_STOP');
    
    if (errors.length === 0) {
      errors.push('UNKNOWN_ERROR');
    }
    
    return errors;
  }

  private determineSeverity(faultCode: number): 'low' | 'medium' | 'high' | 'critical' {
    if (faultCode & 0x460) {
      return 'critical';
    }
    
    if (faultCode & 0x11F) {
      return 'high';
    }
    
    if (faultCode & 0x80) {
      return 'medium';
    }
    
    return 'low';
  }

  private async reportCriticalError(
    deviceId: number, 
    errorTypes: string[], 
    faultCode: number, 
    severity: string
  ): Promise<void> {
    const errorData = {
      device_id: deviceId,
      error_types: errorTypes,
      fault_code: faultCode,
      severity: severity,
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await this.grpcMainService.reportCriticalError(errorData);
      
      if (response.success) {
        this.logger.log(`Critical error reported for device ${deviceId}: ${response.action_required}`);
      } else {
        this.logger.error(`Failed to report critical error for device ${deviceId}`);
      }
    } catch (error) {
      this.logger.error(`gRPC error reporting failed: ${error.message}`);
      throw error;
    }
  }

  async getOnlineDevices(): Promise<Device[]> {
    return Array.from(this.devices.values()).filter(d => d.online);
  }

  async getOfflineDevices(): Promise<Device[]> {
    return Array.from(this.devices.values()).filter(d => !d.online);
  }

  async getDevicesWithErrors(): Promise<Device[]> {
    return Array.from(this.devices.values()).filter(d => d.lastError !== undefined);
  }

  async clearDeviceError(deviceId: number): Promise<void> {
    const device = this.devices.get(deviceId);
    if (device) {
      delete device.lastError;
      this.logger.log(`Cleared error for device ${deviceId}`);
    }
  }

  async removeDevice(deviceId: number): Promise<void> {
    if (this.devices.delete(deviceId)) {
      this.logger.log(`Device ${deviceId} removed from registry`);
    }
  }

  getDeviceStats() {
    const devices = Array.from(this.devices.values());
    return {
      total: devices.length,
      online: devices.filter(d => d.online).length,
      offline: devices.filter(d => !d.online).length,
      withErrors: devices.filter(d => d.lastError).length,
      byType: {
        evse: devices.filter(d => d.type === 'EVSE').length,
        host: devices.filter(d => d.type === 'HOST').length,
      },
    };
  }
}