import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mqtt from 'mqtt';
import { DeviceService } from '../device/device.service';
import { GrpcDbcService } from '../grpc/grpc-dbc.service';
import { SessionService } from '../session/session.service';
import { RedisService } from '../redis/redis.service';
import { CRC16 } from './utils/crc16.util';

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client: mqtt.MqttClient;
  
  private readonly pendingRetries = new Map<string, number>();
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 1000;

  constructor(
    private configService: ConfigService,
    private deviceService: DeviceService,
    private grpcDbcService: GrpcDbcService,
    private sessionService: SessionService,
    private redisService: RedisService,
  ) {}

  async onModuleInit() {
    await this.connect();
    this.setupRegistrationTopics();
  }

  async onModuleDestroy() {
    if (this.client) {
      this.client.end();
    }
  }

  private setupRegistrationTopics() {
    const registrationTopics = [
      '/EVSE_REGISTER', 
      '/HOST_REGISTER',
      '/EVSE/+/INBOX',
      '/HOST/+/INBOX',
    ];
    
    registrationTopics.forEach(topic => {
      this.client.subscribe(topic);
      this.logger.log(`Subscribed to: ${topic}`);
    });
    
    this.logger.log('Subscribed to all MQTT topics');
  }

  private async connect() {
    const brokerUrl = this.configService.get('mqtt.brokerUrl');
    const clientId = this.configService.get('mqtt.clientId');
    const username = this.configService.get('mqtt.username');
    const password = this.configService.get('mqtt.password');
    
    this.client = mqtt.connect(brokerUrl, {
      clientId,
      username,
      password,
      clean: true,
      reconnectPeriod: 1000,
      connectTimeout: 30000,
    });

    this.client.on('connect', () => {
      this.logger.log(`Connected to MQTT broker: ${brokerUrl}`);
    });

    this.client.on('message', this.handleMessage.bind(this));
    
    this.client.on('error', (error) => {
      this.logger.error(`MQTT error: ${error.message}`);
    });
  }

  private async handleMessage(topic: string, payload: Buffer) {
    this.logger.log(`📨 Received on topic: ${topic}, length: ${payload.length}`);
    
    try {
      const validation = this.validateFrame(payload);
      
      if (!validation.valid) {
        this.logger.warn(`❌ Frame validation failed: ${validation.error}`);
        
        const deviceId = this.extractDeviceIdFromTopic(topic);
        if (deviceId && !topic.includes('REGISTER')) {
          await this.handleInvalidFrame(deviceId, payload, validation.error);
        }
        
        return;
      }
      
      this.logger.debug(`Frame validated successfully, CRC: ${validation.crc}`);
      
      const deviceId = this.extractDeviceIdFromTopic(topic);
      if (deviceId) {
        this.clearRetryCounter(deviceId);
      }
      
      const frameData = payload.toString('hex').toUpperCase();
      
      const parsedFrame = await this.grpcDbcService.parseFrame({
        frame_data: frameData,
        timestamp: new Date().toISOString(),
      });
  
      this.logger.log(`🔍 Parsed: ${parsedFrame.parsed}, message: ${parsedFrame.message_name}`);
  
      if (!parsedFrame.parsed) {
        this.logger.warn(`Failed to parse frame from ${topic}: ${parsedFrame.error}`);
        return;
      }
      await this.publishParsedData(parsedFrame);
      await this.processMessage(topic, parsedFrame);
  
    } catch (error) {
      this.logger.error(`Error processing MQTT message: ${error.message}`);
      this.logger.error(error.stack);
    }
  }

  private validateFrame(payload: Buffer): { 
    valid: boolean; 
    error?: string;
    crc?: string;
  } {
    if (payload.length !== 12) {
      return {
        valid: false,
        error: `Invalid frame length: ${payload.length}, expected 12`,
      };
    }
    
    const crcData = payload.subarray(0, 10);  // COMM_ADDR (2) + DATA (8)
    const crcBytes = payload.subarray(10, 12); // CRC16 (2)
    const crcReceived = crcBytes.readUInt16LE(0);
    const crcCalculated = CRC16.calculate(crcData);
    
    if (crcCalculated !== crcReceived) {
      return {
        valid: false,
        error: `CRC mismatch: calculated=${CRC16.format(crcCalculated)}, received=${CRC16.format(crcReceived)}`,
      };
    }
    
    return {
      valid: true,
      crc: CRC16.format(crcCalculated),
    };
  }

  private async handleInvalidFrame(
    deviceId: number,
    payload: Buffer,
    error: string,
  ): Promise<void> {
    const commAddr = payload.readUInt16LE(0);
    const msgId = (commAddr >> 5) & 0x3FF;
    
    const retryKey = `${deviceId}_${msgId}`;
    const currentRetries = this.pendingRetries.get(retryKey) || 0;
    
    if (currentRetries >= this.MAX_RETRIES) {
      this.logger.error(
        `Max retries (${this.MAX_RETRIES}) reached for device ${deviceId}, message ${msgId}. ${error}`
      );
      
      this.pendingRetries.delete(retryKey);
      // await this.deviceService.reportError(
      //   deviceId, 
      //   `CRC validation failed after ${this.MAX_RETRIES} retries: ${error}`
      // );
      return;
    }
    
    this.pendingRetries.set(retryKey, currentRetries + 1);
    
    this.logger.warn(
      `🔁 Retrying request for device ${deviceId}, message ${msgId}. ` +
      `Attempt ${currentRetries + 1}/${this.MAX_RETRIES}. Reason: ${error}`
    );
    
    await this.sleep(this.RETRY_DELAY_MS);
    
    await this.requestDeviceData(deviceId, msgId);
  }

  private clearRetryCounter(deviceId: number): void {
    const keysToDelete: string[] = [];
    this.pendingRetries.forEach((_, key) => {
      if (key.startsWith(`${deviceId}_`)) {
        keysToDelete.push(key);
      }
    });
    
    keysToDelete.forEach(key => this.pendingRetries.delete(key));
  }

  private extractDeviceIdFromTopic(topic: string): number | null {
    const match = topic.match(/\/(EVSE|HOST)\/(\d+)\/(INBOX|OUTBOX)/);
    return match ? parseInt(match[2], 10) : null;
  }

  private async publishParsedData(parsedFrame: any): Promise<void> {
    try {
      const { message_name, device_address, signals_json, crc_valid, timestamp } = parsedFrame;
      
      const jsonPayload = {
        device_address,
        message_name,
        signals: JSON.parse(signals_json || '{}'),
        crc_valid,
        timestamp,
      };

      const parsedTopic = `/DBC_PARSED/${device_address}`;
      
      this.client.publish(
        parsedTopic,
        JSON.stringify(jsonPayload),
        { qos: 1 },
        (error) => {
          if (error) {
            this.logger.error(`Failed to publish parsed data to ${parsedTopic}: ${error.message}`);
          } else {
            this.logger.debug(`📤 Published parsed data to: ${parsedTopic}`);
          }
        }
      );

    } catch (error) {
      this.logger.error(`Error publishing parsed data to MQTT: ${error.message}`);
    }
  }
  
  private async subscribeToDeviceTopics(deviceId: number): Promise<void> {
    const inboxTopic = `/EVSE/${deviceId}/INBOX`;
    
    return new Promise((resolve, reject) => {
      this.client.subscribe(inboxTopic, (err) => {
        if (err) {
          this.logger.error(`❌ Failed to subscribe to ${inboxTopic}: ${err.message}`);
          reject(err);
        } else {
          this.logger.log(`✅ Subscribed to device topic: ${inboxTopic}`);
          resolve();
        }
      });
    });
  }

  private async processMessage(topic: string, parsedFrame: any) {
    const { message_name, device_address, signals_json } = parsedFrame;
    const signals = JSON.parse(signals_json || '{}');

    switch (message_name) {
      case 'evse_state':
        if (topic.includes('REGISTER')) {
          await this.deviceService.registerDevice(device_address, signals);
          await this.subscribeToDeviceTopics(device_address);
        } else {
          await this.deviceService.updateDeviceState(device_address, signals);
        }
        break;

      case 'evse_session':
        await this.handleChargingSession(device_address, signals);
        break;

      case 'evse_data1':
      case 'evse_data2':
        await this.handleMetricData(device_address, message_name, signals);
        break;
    }
  }

  private async handleChargingSession(deviceId: number, signals: any) {
    this.logger.log(`Charging session from device ${deviceId}:`, signals);
    
    try {
      await this.sessionService.handleSessionData(deviceId, signals);
    } catch (error) {
      this.logger.error(`Failed to handle charging session: ${error.message}`);
    }
  }

  private async handleMetricData(deviceId: number, messageType: string, signals: any) {
    this.logger.log(`Metric data from device ${deviceId}: ${messageType}`);
    
    try {
      await this.redisService.publishMetrics(deviceId, messageType, signals);
    } catch (error) {
      this.logger.error(`Failed to publish metrics: ${error.message}`);
    }
  }

  private buildRemoteCmdFrame(deviceId: number, command: any): Buffer {
    const msgId = 34;
    
    const commAddr = (deviceId & 0x1F) | ((msgId & 0x3FF) << 5);
    const commAddrBytes = Buffer.allocUnsafe(2);
    commAddrBytes.writeUInt16LE(commAddr, 0);
    
    const canData = Buffer.allocUnsafe(8);
    canData.writeUInt8(command.data_req || 0, 0);
    canData.writeUInt8(command.req_msg_id || 0, 1);
    canData.writeUInt8(command.charge_cmd_p0 || 0, 2);
    canData.writeUInt8(command.charge_cmd_p1 || 0, 3);
    canData.writeUInt16LE(command.cmd_charge_time_max || 0, 4);
    canData.writeUInt16LE(command.cmd_charge_wh_max || 0, 6);
    
    const crcData = Buffer.concat([commAddrBytes, canData]);
    const crc = CRC16.calculate(crcData);
    const crcBytes = Buffer.allocUnsafe(2);
    crcBytes.writeUInt16LE(crc, 0);
    
    return Buffer.concat([commAddrBytes, canData, crcBytes]);
  }
  
  async sendCommand(deviceId: number, command: any): Promise<void> {
    const topic = `/EVSE/${deviceId}/OUTBOX`;
    
    try {
      const frameBuffer = this.buildRemoteCmdFrame(deviceId, command);
      
      this.client.publish(topic, frameBuffer);
      this.logger.log(`Command sent to device ${deviceId}`);
    } catch (error) {
      this.logger.error(`Failed to send command to device ${deviceId}: ${error.message}`);
      throw error;
    }
  }
  
  async requestDeviceData(deviceId: number, requestedMsgId: number): Promise<void> {
    const command = {
      data_req: 1,
      req_msg_id: requestedMsgId,
      charge_cmd_p0: 0,
      charge_cmd_p1: 0,
      cmd_charge_time_max: 0,
      cmd_charge_wh_max: 0,
    };
  
    await this.sendCommand(deviceId, command);
  }
  
  async startCharging(deviceId: number, port: number, maxTime: number, maxEnergy: number): Promise<void> {
    const chargeCmdValue = 0x11;
    
    const command = {
      data_req: 0,
      req_msg_id: 0,
      charge_cmd_p0: port === 0 ? chargeCmdValue : 0,
      charge_cmd_p1: port === 1 ? chargeCmdValue : 0,
      cmd_charge_time_max: maxTime,
      cmd_charge_wh_max: maxEnergy,
    };
  
    await this.sendCommand(deviceId, command);
    this.logger.log(`Started charging on device ${deviceId}, port ${port}`);
  }
  
  async stopCharging(deviceId: number, port: number): Promise<void> {
    const command = {
      data_req: 0,
      req_msg_id: 0,
      charge_cmd_p0: port === 0 ? 0 : undefined,
      charge_cmd_p1: port === 1 ? 0 : undefined,
      cmd_charge_time_max: 0,
      cmd_charge_wh_max: 0,
    };
  
    await this.sendCommand(deviceId, command);
    this.logger.log(`Stopped charging on device ${deviceId}, port ${port}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}