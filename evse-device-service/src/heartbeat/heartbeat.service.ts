import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DeviceService } from '../device/device.service';
import { MqttService } from '../mqtt/mqtt.service';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class HeartbeatService {
  private readonly logger = new Logger(HeartbeatService.name);

  constructor(
    private deviceService: DeviceService,
    private mqttService: MqttService,
    private redisService: RedisService,
  ) {}

  @Cron('0 */10 * * * *')
  async performHeartbeat() {
    this.logger.log('Starting heartbeat cycle');
    
    const devices = await this.deviceService.getAllDevices();
    const onlineDevices = devices.filter(d => d.online);
    
    for (const device of onlineDevices) {
      await this.checkDevice(device.id);
      await this.sleep(2000);
    }
    
    this.logger.log(`Heartbeat completed for ${onlineDevices.length} devices`);
  }

  private async checkDevice(deviceId: number) {
    try {
      await this.mqttService.requestDeviceData(deviceId, 20);
      await this.sleep(1000);
      await this.mqttService.requestDeviceData(deviceId, 16);
      
      await this.redisService.publishHeartbeat(deviceId, {
        status: 'online',
        last_check: new Date().toISOString(),
      });
      
      this.logger.debug(`Heartbeat sent to device ${deviceId}`);
      
    } catch (error) {
      this.logger.error(`Heartbeat failed for device ${deviceId}: ${error.message}`);
      await this.deviceService.markDeviceOffline(deviceId);
      
      await this.redisService.publishHeartbeat(deviceId, {  
        status: 'offline',
        error: error.message,
        last_check: new Date().toISOString(),
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}