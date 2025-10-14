#!/bin/bash

# NestJS EVSE Service Setup Script
echo "🏗️ Setting up NestJS EVSE Device Service..."

PROJECT_NAME="evse-device-service"

# Проверка наличия Node.js и npm
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 18+ first."
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo "❌ npm not found. Please install npm first."
    exit 1
fi

# Проверка и установка Nest CLI
if ! command -v nest &> /dev/null; then
    echo "🔧 Installing NestJS CLI..."
    npm install -g @nestjs/cli
fi

# Создание NestJS проекта
echo "📁 Creating NestJS project..."
nest new $PROJECT_NAME --package-manager npm

cd $PROJECT_NAME

# =============================================================================
# Установка дополнительных зависимостей
# =============================================================================
echo "📦 Installing additional dependencies..."

# Core dependencies
npm install --save \
  @nestjs/config \
  @nestjs/schedule \
  @nestjs/microservices \
  @grpc/grpc-js \
  @grpc/proto-loader \
  mqtt \
  ioredis \
  axios \
  joi \
  winston \
  rxjs

# Dev dependencies
npm install --save-dev \
  @types/node \
  grpc-tools

# =============================================================================
# Создание структуры папок
# =============================================================================
echo "📁 Creating project structure..."
mkdir -p src/mqtt
mkdir -p src/grpc
mkdir -p src/redis
mkdir -p src/device
mkdir -p src/session
mkdir -p src/heartbeat
mkdir -p src/config
mkdir -p proto
mkdir -p shared

# =============================================================================
# proto/dbc.proto
# =============================================================================
echo "📝 Creating protobuf schemas..."
cat > proto/dbc.proto << 'EOF'
syntax = "proto3";

package dbc;

service DBCParserService {
  rpc ParseFrame(ParseFrameRequest) returns (ParseFrameResponse);
  rpc ParseBatch(ParseBatchRequest) returns (stream ParseFrameResponse);
}

message ParseFrameRequest {
  string frame_data = 1;
  string timestamp = 2;
}

message ParseFrameResponse {
  int32 device_address = 1;
  int32 message_id = 2;
  string message_name = 3;
  string signals_json = 4;
  string raw_payload = 5;
  bool crc_valid = 6;
  bool parsed = 7;
  string error = 8;
  string timestamp = 9;
}

message ParseBatchRequest {
  repeated ParseFrameRequest frames = 1;
}
EOF

# =============================================================================
# proto/evse.proto
# =============================================================================
cat > proto/evse.proto << 'EOF'
syntax = "proto3";

package evse;

service EVSEService {
  rpc SaveChargingSession(ChargingSessionRequest) returns (ChargingSessionResponse);
  rpc ReportCriticalError(CriticalErrorRequest) returns (CriticalErrorResponse);
  rpc StartCharging(StartChargingRequest) returns (StartChargingResponse);
  rpc StopCharging(StopChargingRequest) returns (StopChargingResponse);
}

message ChargingSessionRequest {
  int32 device_id = 1;
  int32 session_id = 2;
  int32 port_number = 3;
  int32 duration_minutes = 4;
  int32 energy_consumed_wh = 5;
  string status = 6;
  string timestamp = 7;
}

message ChargingSessionResponse {
  bool success = 1;
  string message = 2;
  int32 billing_id = 3;
}

message CriticalErrorRequest {
  int32 device_id = 1;
  repeated string error_types = 2;
  int32 fault_code = 3;
  string severity = 4;
  string timestamp = 5;
}

message CriticalErrorResponse {
  bool success = 1;
  string action_required = 2;
}

message StartChargingRequest {
  int32 device_id = 1;
  int32 port = 2;
  int32 max_time_minutes = 3;
  int32 max_energy_wh = 4;
}

message StartChargingResponse {
  bool success = 1;
  int32 session_id = 2;
  string status = 3;
}

message StopChargingRequest {
  int32 device_id = 1;
  int32 port = 2;
}

message StopChargingResponse {
  bool success = 1;
  int32 final_session_id = 2;
  int32 final_energy = 3;
}
EOF

# =============================================================================
# src/config/config.module.ts
# =============================================================================
echo "📝 Creating configuration module..."
cat > src/config/configuration.ts << 'EOF'
export default () => ({
  port: parseInt(process.env.PORT, 10) || 3001,
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    clientId: `evse-service-${Date.now()}`,
  },
  grpc: {
    dbcServiceUrl: process.env.DBC_SERVICE_URL || 'localhost:50051',
    mainBackendUrl: process.env.MAIN_BACKEND_GRPC_URL || 'localhost:50052',
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
});
EOF

# =============================================================================
# src/mqtt/mqtt.module.ts
# =============================================================================
echo "📝 Creating MQTT module..."
cat > src/mqtt/mqtt.module.ts << 'EOF'
import { Module } from '@nestjs/common';
import { MqttService } from './mqtt.service';
import { DeviceModule } from '../device/device.module';
import { GrpcModule } from '../grpc/grpc.module';

@Module({
  imports: [DeviceModule, GrpcModule],
  providers: [MqttService],
  exports: [MqttService],
})
export class MqttModule {}
EOF

cat > src/mqtt/mqtt.service.ts << 'EOF'
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mqtt from 'mqtt';
import { DeviceService } from '../device/device.service';
import { GrpcDbcService } from '../grpc/grpc-dbc.service';

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private client: mqtt.MqttClient;

  constructor(
    private configService: ConfigService,
    private deviceService: DeviceService,
    private grpcDbcService: GrpcDbcService,
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

  private async connect() {
    const brokerUrl = this.configService.get('mqtt.brokerUrl');
    const clientId = this.configService.get('mqtt.clientId');
    
    this.client = mqtt.connect(brokerUrl, {
      clientId,
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

  private setupRegistrationTopics() {
    const registrationTopics = ['/EVSE_REGISTER', '/HOST_REGISTER'];
    
    registrationTopics.forEach(topic => {
      this.client.subscribe(topic);
    });
    
    this.logger.log('Subscribed to registration topics');
  }

  private async handleMessage(topic: string, payload: Buffer) {
    try {
      const frameData = payload.toString('hex').toUpperCase();
      
      // Парсинг через gRPC DBC Service
      const parsedFrame = await this.grpcDbcService.parseFrame({
        frame_data: frameData,
        timestamp: new Date().toISOString(),
      });

      if (!parsedFrame.parsed) {
        this.logger.warn(`Failed to parse frame from ${topic}: ${parsedFrame.error}`);
        return;
      }

      await this.processMessage(topic, parsedFrame);

    } catch (error) {
      this.logger.error(`Error processing MQTT message: ${error.message}`);
    }
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

  private async subscribeToDeviceTopics(deviceId: number) {
    const inboxTopic = `/EVSE/${deviceId}/INBOX`;
    this.client.subscribe(inboxTopic);
    this.logger.log(`Subscribed to device topic: ${inboxTopic}`);
  }

  private async handleChargingSession(deviceId: number, signals: any) {
    this.logger.log(`Charging session from device ${deviceId}:`, signals);
    // Здесь будет вызов к Main Backend через gRPC
  }

  private async handleMetricData(deviceId: number, messageType: string, signals: any) {
    this.logger.log(`Metric data from device ${deviceId}: ${messageType}`);
    // Здесь будет публикация в Redis
  }

  async sendCommand(deviceId: number, command: any): Promise<void> {
    const topic = `/EVSE/${deviceId}/OUTBOX`;
    
    // TODO: Формирование remote_cmd фрейма
    const commandData = Buffer.from('command_placeholder', 'hex');
    
    this.client.publish(topic, commandData);
    this.logger.log(`Command sent to device ${deviceId}`);
  }
}
EOF

# =============================================================================
# src/grpc/grpc.module.ts
# =============================================================================
echo "📝 Creating gRPC module..."
cat > src/grpc/grpc.module.ts << 'EOF'
import { Module } from '@nestjs/common';
import { GrpcDbcService } from './grpc-dbc.service';
import { GrpcMainService } from './grpc-main.service';

@Module({
  providers: [GrpcDbcService, GrpcMainService],
  exports: [GrpcDbcService, GrpcMainService],
})
export class GrpcModule {}
EOF

cat > src/grpc/grpc-dbc.service.ts << 'EOF'
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

@Injectable()
export class GrpcDbcService implements OnModuleInit {
  private readonly logger = new Logger(GrpcDbcService.name);
  private dbcClient: any;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.connectToDbcService();
  }

  private async connectToDbcService() {
    const packageDefinition = protoLoader.loadSync('proto/dbc.proto', {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    const dbcServiceUrl = this.configService.get('grpc.dbcServiceUrl');

    this.dbcClient = new proto.dbc.DBCParserService(
      dbcServiceUrl,
      grpc.credentials.createInsecure()
    );

    this.logger.log(`Connected to DBC Service at ${dbcServiceUrl}`);
  }

  async parseFrame(request: { frame_data: string; timestamp?: string }): Promise<any> {
    return new Promise((resolve, reject) => {
      this.dbcClient.ParseFrame(request, (error: any, response: any) => {
        if (error) {
          this.logger.error(`DBC parse error: ${error.message}`);
          reject(error);
        } else {
          resolve(response);
        }
      });
    });
  }

  async parseBatch(frames: any[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const results: any[] = [];
      
      const stream = this.dbcClient.ParseBatch({ frames });
      
      stream.on('data', (response: any) => {
        results.push(response);
      });
      
      stream.on('end', () => {
        resolve(results);
      });
      
      stream.on('error', (error: any) => {
        reject(error);
      });
    });
  }
}
EOF

cat > src/grpc/grpc-main.service.ts << 'EOF'
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

@Injectable()
export class GrpcMainService implements OnModuleInit {
  private readonly logger = new Logger(GrpcMainService.name);
  private mainClient: any;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.connectToMainBackend();
  }

  private async connectToMainBackend() {
    const packageDefinition = protoLoader.loadSync('proto/evse.proto', {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    const mainBackendUrl = this.configService.get('grpc.mainBackendUrl');

    this.mainClient = new proto.evse.EVSEService(
      mainBackendUrl,
      grpc.credentials.createInsecure()
    );

    this.logger.log(`Connected to Main Backend at ${mainBackendUrl}`);
  }

  async saveChargingSession(sessionData: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.mainClient.SaveChargingSession(sessionData, (error: any, response: any) => {
        if (error) {
          this.logger.error(`Failed to save session: ${error.message}`);
          reject(error);
        } else {
          resolve(response);
        }
      });
    });
  }

  async reportCriticalError(errorData: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.mainClient.ReportCriticalError(errorData, (error: any, response: any) => {
        if (error) {
          this.logger.error(`Failed to report error: ${error.message}`);
          reject(error);
        } else {
          resolve(response);
        }
      });
    });
  }
}
EOF

# =============================================================================
# src/device/device.module.ts
# =============================================================================
echo "📝 Creating device module..."
cat > src/device/device.module.ts << 'EOF'
import { Module } from '@nestjs/common';
import { DeviceService } from './device.service';

@Module({
  providers: [DeviceService],
  exports: [DeviceService],
})
export class DeviceModule {}
EOF

cat > src/device/device.service.ts << 'EOF'
import { Injectable, Logger } from '@nestjs/common';

export interface Device {
  id: number;
  type: 'EVSE' | 'HOST';
  online: boolean;
  ports: number;
  lastSeen: Date;
  registeredAt: Date;
  hostId?: number; // Для PLC устройств
}

@Injectable()
export class DeviceService {
  private readonly logger = new Logger(DeviceService.name);
  private devices = new Map<number, Device>();

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
    
    // Обработка ошибок устройства
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
    // Определение количества портов из evse_state
    const port0Ready = stateData.port0_evse_rdy !== undefined;
    const port1Ready = stateData.port1_evse_rdy !== undefined;
    
    return port0Ready && port1Ready ? 2 : 1;
  }

  private async handleDeviceError(deviceId: number, faultCode: number): Promise<void> {
    // Декодирование битовых флагов ошибок
    const errors = this.decodeFaultCode(faultCode);
    const criticalErrors = errors.filter(err => err.critical);
    
    if (criticalErrors.length > 0) {
      this.logger.error(`Critical errors from device ${deviceId}:`, criticalErrors);
      // Здесь будет отправка в Main Backend через gRPC
    }
  }

  private decodeFaultCode(faultCode: number): Array<{type: string, critical: boolean}> {
    const errors = [];
    
    if (faultCode & (1 << 1)) errors.push({type: 'HIGH_VOLTAGE', critical: true});
    if (faultCode & (1 << 2)) errors.push({type: 'LOW_VOLTAGE', critical: true});
    if (faultCode & (1 << 3)) errors.push({type: 'OVERCURRENT_P0', critical: false});
    if (faultCode & (1 << 4)) errors.push({type: 'OVERCURRENT_P1', critical: false});
    if (faultCode & (1 << 5)) errors.push({type: 'RELAY_FAULT', critical: false});
    if (faultCode & (1 << 6)) errors.push({type: 'RCD_FAULT', critical: false});
    if (faultCode & (1 << 7)) errors.push({type: 'PILOT_ERROR', critical: false});
    if (faultCode & (1 << 8)) errors.push({type: 'OVERHEAT_INPUT', critical: true});
    if (faultCode & (1 << 9)) errors.push({type: 'OVERHEAT_OUTPUT', critical: true});
    if (faultCode & (1 << 10)) errors.push({type: 'OVERHEAT_AMBIENT', critical: true});
    if (faultCode & (1 << 11)) errors.push({type: 'WATCHDOG_RESET', critical: false});
    if (faultCode & (1 << 12)) errors.push({type: 'FIRE_ALARM', critical: true});
    
    return errors;
  }
}
EOF

# =============================================================================
# src/heartbeat/heartbeat.module.ts
# =============================================================================
echo "📝 Creating heartbeat module..."
cat > src/heartbeat/heartbeat.module.ts << 'EOF'
import { Module } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service';
import { DeviceModule } from '../device/device.module';
import { MqttModule } from '../mqtt/mqtt.module';

@Module({
  imports: [DeviceModule, MqttModule],
  providers: [HeartbeatService],
})
export class HeartbeatModule {}
EOF

cat > src/heartbeat/heartbeat.service.ts << 'EOF'
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DeviceService } from '../device/device.service';
import { MqttService } from '../mqtt/mqtt.service';

@Injectable()
export class HeartbeatService {
  private readonly logger = new Logger(HeartbeatService.name);

  constructor(
    private deviceService: DeviceService,
    private mqttService: MqttService,
  ) {}

  @Cron('0 */10 * * * *') // Каждые 10 минут
  async performHeartbeat() {
    this.logger.log('Starting heartbeat cycle');
    
    const devices = await this.deviceService.getAllDevices();
    
    for (const device of devices.filter(d => d.online)) {
      await this.checkDevice(device.id);
      
      // Задержка между устройствами для избежания перегрузки
      await this.sleep(2000);
    }
    
    this.logger.log(`Heartbeat completed for ${devices.length} devices`);
  }

  private async checkDevice(deviceId: number) {
    try {
      // Запрос evse_data2 (температуры, напряжения)
      await this.requestDeviceData(deviceId, 134); // evse_data2
      
      // Небольшая пауза
      await this.sleep(1000);
      
      // Запрос evse_state (основное состояние)  
      await this.requestDeviceData(deviceId, 132); // evse_state
      
      this.logger.debug(`Heartbeat sent to device ${deviceId}`);
      
    } catch (error) {
      this.logger.error(`Heartbeat failed for device ${deviceId}: ${error.message}`);
      await this.deviceService.markDeviceOffline(deviceId);
    }
  }

  private async requestDeviceData(deviceId: number, msgId: number) {
    // Формирование remote_cmd с data_req=1
    const command = {
      data_req: 1,
      req_msg_id: msgId,
      charge_cmd_p0: 0,
      charge_cmd_p1: 0,
      cmd_charge_time_max: 0,
      cmd_charge_wh_max: 0,
    };

    await this.mqttService.sendCommand(deviceId, command);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
EOF

# =============================================================================
# src/redis/redis.module.ts
# =============================================================================
echo "📝 Creating Redis module..."
cat > src/redis/redis.module.ts << 'EOF'
import { Module } from '@nestjs/common';
import { RedisService } from './redis.service';

@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
EOF

cat > src/redis/redis.service.ts << 'EOF'
import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private publisher: Redis;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    if (this.publisher) {
      this.publisher.disconnect();
    }
  }

  private async connect() {
    const redisUrl = this.configService.get('redis.url');
    
    this.publisher = new Redis(redisUrl, {
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 3,
    });

    this.publisher.on('connect', () => {
      this.logger.log(`Connected to Redis: ${redisUrl}`);
    });

    this.publisher.on('error', (error) => {
      this.logger.error(`Redis error: ${error.message}`);
    });
  }

  async publishHeartbeat(deviceId: number, data: any): Promise<void> {
    const message = {
      device_id: deviceId,
      message_type: 'heartbeat',
      data,
      timestamp: new Date().toISOString(),
    };

    await this.publisher.publish('evse:heartbeat', JSON.stringify(message));
    this.logger.debug(`Published heartbeat for device ${deviceId}`);
  }

  async publishMetrics(deviceId: number, messageType: string, data: any): Promise<void> {
    const message = {
      device_id: deviceId,
      message_type: messageType,
      data,
      timestamp: new Date().toISOString(),
    };

    await this.publisher.publish('evse:metrics', JSON.stringify(message));
    this.logger.debug(`Published metrics for device ${deviceId}: ${messageType}`);
  }

  async publishStatusUpdate(deviceId: number, status: any): Promise<void> {
    const message = {
      device_id: deviceId,
      status,
      timestamp: new Date().toISOString(),
    };

    await this.publisher.publish('evse:status', JSON.stringify(message));
    this.logger.debug(`Published status update for device ${deviceId}`);
  }
}
EOF

# =============================================================================
# src/session/session.module.ts
# =============================================================================
echo "📝 Creating session module..."
cat > src/session/session.module.ts << 'EOF'
import { Module } from '@nestjs/common';
import { SessionService } from './session.service';
import { GrpcModule } from '../grpc/grpc.module';

@Module({
  imports: [GrpcModule],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
EOF

cat > src/session/session.service.ts << 'EOF'
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
      // Новая сессия
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
      // Обновление существующей сессии
      existingSession.lastUpdate = new Date();
    }

    // Отправка критичных биллинговых данных в Main Backend
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
EOF

# =============================================================================
# Обновление main.ts
# =============================================================================
echo "📝 Updating main.ts..."
cat > src/main.ts << 'EOF'
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  const port = configService.get('port');
  
  await app.listen(port);
  
  logger.log(`🚀 EVSE Device Service running on port ${port}`);
  logger.log(`📡 MQTT: ${configService.get('mqtt.brokerUrl')}`);
  logger.log(`🔧 DBC Service: ${configService.get('grpc.dbcServiceUrl')}`);
  logger.log(`🏢 Main Backend: ${configService.get('grpc.mainBackendUrl')}`);
}
bootstrap();
EOF

# =============================================================================
# Обновление app.module.ts
# =============================================================================
echo "📝 Updating app.module.ts..."
cat > src/app.module.ts << 'EOF'
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { MqttModule } from './mqtt/mqtt.module';
import { GrpcModule } from './grpc/grpc.module';
import { RedisModule } from './redis/redis.module';
import { DeviceModule } from './device/device.module';
import { SessionModule } from './session/session.module';
import { HeartbeatModule } from './heartbeat/heartbeat.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    MqttModule,
    GrpcModule,
    RedisModule,
    DeviceModule,
    SessionModule,
    HeartbeatModule,
  ],
})
export class AppModule {}
EOF

# =============================================================================
# .env файл
# =============================================================================
echo "📝 Creating .env file..."
cat > .env << 'EOF'
# EVSE Device Service Configuration
NODE_ENV=development
PORT=3001

# MQTT Configuration
MQTT_BROKER_URL=mqtt://localhost:1883

# gRPC Services
DBC_SERVICE_URL=localhost:50051
MAIN_BACKEND_GRPC_URL=localhost:50052

# Redis
REDIS_URL=redis://localhost:6379

# Logging
LOG_LEVEL=info
EOF

# =============================================================================
# package.json scripts update
# =============================================================================
echo "📝 Updating package.json scripts..."
npm pkg set scripts.start:dev="nest start --watch"
npm pkg set scripts.start:debug="nest start --debug --watch"
npm pkg set scripts.start:prod="node dist/main"
npm pkg set scripts.proto:gen="grpc_tools_node_protoc --js_out=import_style=commonjs,binary:./proto --grpc_out=grpc_js:./proto --plugin=protoc-gen-grpc=./node_modules/.bin/grpc_tools_node_protoc_plugin proto/*.proto"

# =============================================================================
# Test файл
# =============================================================================
echo "📝 Creating test file..."
cat > test-service.js << 'EOF'
const mqtt = require('mqtt');

console.log('🧪 Testing EVSE Device Service...');

// Тестовый MQTT клиент
const client = mqtt.connect('mqtt://localhost:1883');

client.on('connect', () => {
  console.log('✅ Connected to MQTT broker');
  
  // Симуляция регистрации EVSE устройства
  const testFrame = Buffer.from('1102002A007D3C0000001234', 'hex');
  
  client.publish('/EVSE_REGISTER', testFrame);
  console.log('📤 Sent test EVSE registration frame');
  
  setTimeout(() => {
    client.end();
    console.log('🎉 Test completed');
  }, 2000);
});

client.on('error', (error) => {
  console.error('❌ MQTT error:', error.message);
});
EOF

# =============================================================================
# README.md
# =============================================================================
echo "📝 Creating README.md..."
cat > README.md << 'EOF'
# EVSE Device Service

NestJS сервис для управления зарядными станциями EVSE.

## Функции

- 📡 MQTT клиент для связи с устройствами
- 🔧 gRPC клиент для парсинга DBC фреймов  
- 🏢 gRPC клиент для отправки критичных данных в Main Backend
- 📤 Redis publisher для асинхронных событий
- ⏰ Heartbeat мониторинг каждые 10 минут
- 🔌 Управление зарядными сессиями

## Установка

```bash
npm install
```

## Запуск

```bash
# Development
npm run start:dev

# Production
npm run build
npm run start:prod
```

## Конфигурация

Настройки в `.env` файле:

- `MQTT_BROKER_URL` - MQTT брокер
- `DBC_SERVICE_URL` - Python DBC Service  
- `MAIN_BACKEND_GRPC_URL` - Main Backend Service
- `REDIS_URL` - Redis сервер

## Тестирование

```bash
# Тест MQTT подключения
node test-service.js
```

## API

Сервис предоставляет внутренние API через:

- gRPC для критичных данных
- Redis Pub/Sub для событий
- MQTT для устройств
EOF

echo ""
echo "🎉 NestJS EVSE Device Service created successfully!"
echo ""
echo "📁 Project structure:"
echo "   $PROJECT_NAME/"
echo "   ├── src/mqtt/          # MQTT communication"
echo "   ├── src/grpc/          # gRPC clients" 
echo "   ├── src/redis/         # Redis publisher"
echo "   ├── src/device/        # Device management"
echo "   ├── src/session/       # Session tracking"
echo "   ├── src/heartbeat/     # Monitoring"
echo "   ├── proto/             # Protobuf schemas"
echo "   └── .env              # Configuration"
echo ""
echo "🚀 To start the service:"
echo "   cd $PROJECT_NAME"
echo "   npm run start:dev"
echo ""
echo "🧪 To test MQTT (in another terminal):"
echo "   cd $PROJECT_NAME"  
echo "   node test-service.js"
echo ""
echo "📖 Service runs on port 3001"
echo "🔧 Make sure you have:"
echo "   - MQTT broker on localhost:1883"
echo "   - Python DBC Service on localhost:50051"
echo "   - Redis on localhost:6379"
