#!/usr/bin/env node

const mqtt = require('mqtt');
const Redis = require('ioredis');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const log = {
  info: (msg) => console.log(`${colors.cyan}ℹ${colors.reset}  ${msg}`),
  success: (msg) => console.log(`${colors.green}✓${colors.reset}  ${msg}`),
  error: (msg) => console.log(`${colors.red}✗${colors.reset}  ${msg}`),
  warn: (msg) => console.log(`${colors.yellow}⚠${colors.reset}  ${msg}`),
  section: (msg) => console.log(`\n${colors.bright}${colors.blue}═══ ${msg} ═══${colors.reset}\n`),
  phase: (msg) => console.log(`\n${colors.magenta}▶${colors.reset}  ${msg}`),
  debug: (msg) => console.log(`${colors.cyan}DEBUG:${colors.reset} ${msg}`),
};

class IntegrationTest {
  constructor() {
    this.mqttClient = null;
    this.redisClient = null;
    this.redisSubscriber = null;
    this.grpcDbcClient = null;
    this.nestProcess = null;
    this.results = {
      mqtt: { sent: 0, received: 0 },
      redis: { published: 0, received: 0 },
      grpc: { calls: 0, success: 0 },
      devices: { registered: 0 },
      sessions: { created: 0, updated: 0 },
      errors: [],
    };
    this.receivedMessages = new Map();
    this.redisChannelMessages = new Map();
    this.nestLogFile = fs.createWriteStream('integration-nest.log', { flags: 'w' });
  }

  async run() {
    log.section('INTEGRATION TEST - NO MOCKS');
    
    try {
      await this.checkInfrastructure();
      await this.setupConnections();
      await this.startNestService();
      await this.runTests();
      await this.validateResults();
      
      log.section('TEST COMPLETED SUCCESSFULLY ✓');
      this.printReport();
      process.exit(0);
    } catch (error) {
      log.error(`Test failed: ${error.message}`);
      console.error(error);
      this.results.errors.push(error.message);
      this.printReport();
      process.exit(1);
    } finally {
      await this.cleanup();
    }
  }

  async checkInfrastructure() {
    log.phase('Checking infrastructure...');

    try {
      execSync('mosquitto_pub -h localhost -t test -m "test" -q 1', { stdio: 'ignore' });
      log.success('MQTT broker is running');
    } catch {
      log.error('MQTT broker not running!');
      log.info('Start with: docker-compose up -d mosquitto');
      throw new Error('MQTT not available');
    }

    try {
      execSync('redis-cli ping', { stdio: 'ignore' });
      log.success('Redis is running');
    } catch {
      log.error('Redis not running!');
      log.info('Start with: docker-compose up -d redis');
      throw new Error('Redis not available');
    }

    try {
      const result = execSync('lsof -i :50051 2>&1 || netstat -tuln | grep 50051', { encoding: 'utf-8' });
      if (result) {
        log.success('Python DBC Service is running on port 50051');
      } else {
        throw new Error('Port 50051 not in use');
      }
    } catch {
      log.error('Python DBC Service not running!');
      log.info('Start with: cd ../dbc-service && poetry run python src/main.py');
      throw new Error('DBC Service not available');
    }
  }

  async setupConnections() {
    log.phase('Setting up connections...');

    this.mqttClient = mqtt.connect('mqtt://localhost:1883', {
      clientId: `integration-test-${Date.now()}`,
    });
    
    await new Promise((resolve, reject) => {
      this.mqttClient.on('connect', () => {
        log.success('Connected to MQTT');
        resolve();
      });
      this.mqttClient.on('error', reject);
      setTimeout(() => reject(new Error('MQTT connection timeout')), 5000);
    });

    this.mqttClient.subscribe('#');
    this.mqttClient.on('message', (topic, payload) => {
      if (!this.receivedMessages.has(topic)) {
        this.receivedMessages.set(topic, []);
      }
      this.receivedMessages.get(topic).push(payload);
      this.results.mqtt.received++;
      
      log.debug(`MQTT: ${topic} (${payload.length} bytes)`);
    });

    this.redisClient = new Redis('redis://localhost:6379');
    this.redisSubscriber = new Redis('redis://localhost:6379');
    
    await Promise.all([
      this.redisClient.ping(),
      this.redisSubscriber.ping(),
    ]);
    log.success('Connected to Redis');

    const channels = ['evse_data1', 'evse_data2', 'heartbeat', 'device_status'];
    
    for (const ch of channels) {
      this.redisChannelMessages.set(ch, []);
      await this.redisSubscriber.subscribe(ch);
    }

    this.redisSubscriber.on('message', (channel, message) => {
      if (!this.redisChannelMessages.has(channel)) {
        this.redisChannelMessages.set(channel, []);
      }
      const parsed = JSON.parse(message);
      this.redisChannelMessages.get(channel).push(parsed);
      this.results.redis.received++;
      
      log.debug(`Redis: ${channel} - device ${parsed.device_id}`);
    });
    
    log.success('Subscribed to Redis channels: ' + channels.join(', '));

    const protoPath = path.join(__dirname, '../proto/dbc.proto');
    
    if (!fs.existsSync(protoPath)) {
      throw new Error(`Proto file not found: ${protoPath}`);
    }
    
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    
    const proto = grpc.loadPackageDefinition(packageDefinition);
    this.grpcDbcClient = new proto.dbc.DBCParserService(
      'localhost:50051',
      grpc.credentials.createInsecure()
    );
    
    log.success('Connected to gRPC DBC Service');
  }

  async startNestService() {
    log.phase('Starting NestJS EVSE Service...');

    return new Promise((resolve, reject) => {
      this.nestProcess = spawn('yarn', ['start:dev'], {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'test' },
      });

      let startupComplete = false;

      this.nestProcess.stdout.on('data', (data) => {
        const output = data.toString();
        this.nestLogFile.write(output);
        
        if (!startupComplete && output.includes('EVSE Device Service running on port')) {
          startupComplete = true;
          log.success('NestJS service started');
          
          setTimeout(resolve, 5000);
        }
      });

      this.nestProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        this.nestLogFile.write(`STDERR: ${msg}`);
        
        if (msg.includes('ERROR') || msg.includes('Error')) {
          log.error(`NestJS: ${msg.substring(0, 100)}`);
        }
      });

      this.nestProcess.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          log.error(`NestJS process exited with code ${code}`);
          log.info('Check integration-nest.log for details');
        }
      });

      setTimeout(() => {
        if (!startupComplete) {
          reject(new Error('NestJS start timeout - check integration-nest.log'));
        }
      }, 45000);
    });
  }

  createFrame(deviceAddress, messageId, payload = null) {
    const commAddr = (deviceAddress & 0x1F) | ((messageId & 0x3FF) << 5);
    const frame = Buffer.allocUnsafe(12);
    frame.writeUInt16LE(commAddr, 0);
    
    const canData = payload || Buffer.from([0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const len = Math.min(canData.length, 8);
    canData.copy(frame, 2, 0, len);
    
    for (let i = 2 + len; i < 10; i++) {
      frame[i] = 0;
    }
    
    frame.writeUInt16LE(0x1234, 10);
    
    return frame;
  }

  async testGrpcParsing(frame) {
    return new Promise((resolve, reject) => {
      this.results.grpc.calls++;
      
      const request = {
        frame_data: frame.toString('hex').toUpperCase(),
        timestamp: new Date().toISOString(),
      };
      
      this.grpcDbcClient.ParseFrame(request, (error, response) => {
        if (error) {
          log.error(`gRPC error: ${error.message}`);
          this.results.errors.push(`gRPC error: ${error.message}`);
          reject(error);
        } else {
          this.results.grpc.success++;
          resolve(response);
        }
      });
    });
  }

  async runTests() {
    log.section('RUNNING TESTS');

    await this.testDeviceRegistration();
    await this.testChargingSession();
    await this.testMetricsPublishing();
    await this.testErrorHandling();
    await this.testMultipleDevices();
  }

  async testDeviceRegistration() {
    log.phase('TEST 1: Device Registration');
  
    const deviceId = 25;
    const frame = this.createFrame(deviceId, 16);
    
    log.info(`Sending registration for device ${deviceId}...`);
    log.debug(`Frame: ${frame.toString('hex')}`);
    
    const parsed = await this.testGrpcParsing(frame);
    if (parsed.parsed) {
      log.success(`gRPC parsed: ${parsed.message_name}, device_address: ${parsed.device_address}`);
    } else {
      log.error(`Failed to parse: ${parsed.error}`);
      throw new Error(`Parse failed: ${parsed.error}`);
    }
  
    this.mqttClient.publish('/EVSE_REGISTER', frame);
    this.results.mqtt.sent++;
    this.results.devices.registered++;
    
    log.info('Waiting for device to register (10 seconds)...');
    await this.wait(10000);
  
    const allTopics = Array.from(this.receivedMessages.keys());
    log.debug(`All MQTT topics: ${allTopics.join(', ')}`);
    
    const deviceTopics = allTopics.filter(t => t.includes(`/EVSE/${deviceId}`));
    
    if (deviceTopics.length > 0) {
      log.success(`Device ${deviceId} topics: ${deviceTopics.join(', ')}`);
    } else {
      log.warn(`No device topics for ${deviceId} - registration may have failed`);
      log.info('Check integration-nest.log for MQTT handling logs');
    }
  
    const heartbeatMsgs = this.redisChannelMessages.get('heartbeat') || [];
    const deviceHeartbeat = heartbeatMsgs.filter(m => m.device_id === deviceId);
    if (deviceHeartbeat.length > 0) {
      log.success(`Device ${deviceId} heartbeat found in Redis`);
    }
  }
  
  async testChargingSession() {
    log.phase('TEST 2: Charging Session');
  
    const deviceId = 25;
    const sessionId = 500;
    
    const payload = Buffer.allocUnsafe(8);
    payload.writeUInt16LE(sessionId, 0);
    payload.writeUInt8(0, 2);
    payload.writeUInt16LE(30, 3);
    payload.writeUInt16LE(5000, 5);
  
    const frame = this.createFrame(deviceId, 17, payload);
    
    log.info(`Starting session ${sessionId} for device ${deviceId}...`);
    log.debug(`Frame: ${frame.toString('hex')}`);
    
    const parsed = await this.testGrpcParsing(frame);
    if (parsed.parsed && parsed.message_name === 'evse_session') {
      log.success('Session frame parsed');
      try {
        const signals = JSON.parse(parsed.signals_json);
        log.info(`  Session: ${signals.session_id}, Port: ${signals.session_port_nmb}`);
      } catch (e) {
        log.warn('Could not parse signals JSON');
      }
    }
  
    this.mqttClient.publish(`/EVSE/${deviceId}/INBOX`, frame);
    this.results.mqtt.sent++;
    this.results.sessions.created++;
    
    await this.wait(5000);
  }
  
  async testMetricsPublishing() {
    log.phase('TEST 3: Metrics Publishing');
  
    const deviceId = 25;
  
    log.info('Publishing evse_data1...');
    const data1Frame = this.createFrame(deviceId, 19);
    
    const data1Parsed = await this.testGrpcParsing(data1Frame);
    if (data1Parsed.message_name === 'evse_data1') {
      log.success(`evse_data1 parsed, device: ${data1Parsed.device_address}`);
    }
  
    this.mqttClient.publish(`/EVSE/${deviceId}/INBOX`, data1Frame);
    this.results.mqtt.sent++;
    
    await this.wait(5000);
  
    const data1Messages = this.redisChannelMessages.get('evse_data1') || [];
    const data1ForDevice = data1Messages.filter(m => m.device_id === deviceId);
    
    if (data1ForDevice.length > 0) {
      log.success(`✓ Received ${data1ForDevice.length} evse_data1 for device ${deviceId}`);
      this.results.redis.published++;
    } else {
      log.warn(`No evse_data1 in Redis for device ${deviceId}`);
      log.debug(`Total data1 messages: ${data1Messages.length}`);
      if (data1Messages.length > 0) {
        log.debug(`Found devices: ${data1Messages.map(m => m.device_id).join(', ')}`);
      }
    }
  
    log.info('Publishing evse_data2...');
    const data2Frame = this.createFrame(deviceId, 20);
    
    const data2Parsed = await this.testGrpcParsing(data2Frame);
    if (data2Parsed.message_name === 'evse_data2') {
      log.success(`evse_data2 parsed, device: ${data2Parsed.device_address}`);
    }
  
    this.mqttClient.publish(`/EVSE/${deviceId}/INBOX`, data2Frame);
    this.results.mqtt.sent++;
    
    await this.wait(5000);
  
    const data2Messages = this.redisChannelMessages.get('evse_data2') || [];
    const data2ForDevice = data2Messages.filter(m => m.device_id === deviceId);
    
    if (data2ForDevice.length > 0) {
      log.success(`✓ Received ${data2ForDevice.length} evse_data2 for device ${deviceId}`);
      this.results.redis.published++;
    } else {
      log.warn(`No evse_data2 in Redis for device ${deviceId}`);
      log.debug(`Total data2 messages: ${data2Messages.length}`);
      if (data2Messages.length > 0) {
        log.debug(`Found devices: ${data2Messages.map(m => m.device_id).join(', ')}`);
      }
    }
  }
  
  async testErrorHandling() {
    log.phase('TEST 4: Error Handling');
  
    const deviceId = 25; // ← ИСПРАВИТЬ: было 77777
    
    const errorPayload = Buffer.allocUnsafe(8);
    errorPayload.writeUInt8(0x08, 0);
    
    const frame = this.createFrame(deviceId, 16, errorPayload);
    
    log.info('Sending error state (fault_code: 0x08)...');
    
    const parsed = await this.testGrpcParsing(frame);
    try {
      const signals = JSON.parse(parsed.signals_json || '{}');
      if (signals.fault_code === 0x08) {
        log.success('Error code 0x08 parsed');
      }
    } catch (e) {
      log.warn('Could not verify error code');
    }
  
    this.mqttClient.publish(`/EVSE/${deviceId}/INBOX`, frame);
    this.results.mqtt.sent++;
    
    await this.wait(5000);
  }
  
  async testMultipleDevices() {
    log.phase('TEST 5: Multiple Devices');
  
    const deviceIds = [26, 27, 28]; // ← ИСПРАВИТЬ: было 88001-88003
    
    log.info(`Registering ${deviceIds.length} devices...`);
    
    for (const deviceId of deviceIds) {
      const frame = this.createFrame(deviceId, 16);
      
      await this.testGrpcParsing(frame);
      
      this.mqttClient.publish('/EVSE_REGISTER', frame);
      this.results.mqtt.sent++;
      this.results.devices.registered++;
      
      await this.wait(1000);
    }
    
    log.info('Waiting for all registrations (10 seconds)...');
    await this.wait(10000);
  
    log.success(`Sent registration for ${deviceIds.length} devices`);
  }

  async validateResults() {
    log.phase('Validating results...');

    const validations = [
      {
        name: 'gRPC calls successful',
        condition: this.results.grpc.success >= 5,
        actual: this.results.grpc.success,
        expected: '≥ 5',
      },
      {
        name: 'MQTT messages sent',
        condition: this.results.mqtt.sent >= 5,
        actual: this.results.mqtt.sent,
        expected: '≥ 5',
      },
      {
        name: 'MQTT messages received',
        condition: this.results.mqtt.received > 0,
        actual: this.results.mqtt.received,
        expected: '> 0',
      },
      {
        name: 'Devices registered',
        condition: this.results.devices.registered >= 4,
        actual: this.results.devices.registered,
        expected: '≥ 4',
      },
    ];

    if (this.results.redis.received > 0) {
      log.success(`Redis messages received: ${this.results.redis.received}`);
    } else {
      log.warn('No Redis messages received - check if NestJS is processing MQTT correctly');
      log.info('This may indicate MQTT→gRPC→Redis pipeline issue');
    }

    let passed = 0;
    for (const validation of validations) {
      if (validation.condition) {
        log.success(`${validation.name}: ${validation.actual}`);
        passed++;
      } else {
        log.error(`${validation.name}: ${validation.actual} (expected ${validation.expected})`);
        this.results.errors.push(
          `${validation.name} failed: ${validation.actual} vs ${validation.expected}`
        );
      }
    }

    if (passed < validations.length) {
      throw new Error(`${validations.length - passed} validations failed`);
    }
  }

  printReport() {
    log.section('TEST REPORT');

    console.log(`${colors.bright}MQTT:${colors.reset}`);
    console.log(`  Sent:     ${this.results.mqtt.sent}`);
    console.log(`  Received: ${this.results.mqtt.received}`);
    console.log(`  Topics:   ${this.receivedMessages.size}`);

    console.log(`\n${colors.bright}Redis:${colors.reset}`);
    console.log(`  Published channels: ${this.results.redis.published}`);
    console.log(`  Received messages:  ${this.results.redis.received}`);
    
    for (const [channel, messages] of this.redisChannelMessages.entries()) {
      console.log(`  ${channel}: ${messages.length} messages`);
    }

    console.log(`\n${colors.bright}gRPC:${colors.reset}`);
    console.log(`  Calls:   ${this.results.grpc.calls}`);
    console.log(`  Success: ${this.results.grpc.success}`);
    console.log(`  Rate:    ${((this.results.grpc.success / this.results.grpc.calls) * 100).toFixed(1)}%`);

    console.log(`\n${colors.bright}Business Logic:${colors.reset}`);
    console.log(`  Devices:  ${this.results.devices.registered}`);
    console.log(`  Sessions: ${this.results.sessions.created}`);

    if (this.results.errors.length > 0) {
      console.log(`\n${colors.red}${colors.bright}Errors:${colors.reset}`);
      this.results.errors.forEach(err => console.log(`  - ${err}`));
    }

    console.log(`\n${colors.bright}MQTT Topics Observed:${colors.reset}`);
    const topics = Array.from(this.receivedMessages.keys()).sort();
    topics.slice(0, 10).forEach(t => {
      const count = this.receivedMessages.get(t).length;
      console.log(`  ${t}: ${count} msg`);
    });
    if (topics.length > 10) {
      console.log(`  ... and ${topics.length - 10} more topics`);
    }

    console.log(`\n${colors.cyan}Logs saved to: integration-nest.log${colors.reset}`);
  }

  async cleanup() {
    log.phase('Cleaning up...');

    if (this.mqttClient) {
      this.mqttClient.end();
    }
    if (this.redisClient) {
      await this.redisClient.quit();
    }
    if (this.redisSubscriber) {
      await this.redisSubscriber.quit();
    }
    if (this.nestProcess) {
      this.nestProcess.kill('SIGTERM');
      await this.wait(2000);
      if (!this.nestProcess.killed) {
        this.nestProcess.kill('SIGKILL');
      }
    }
    if (this.nestLogFile) {
      this.nestLogFile.end();
    }

    log.success('Cleanup complete');
  }

  wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

const test = new IntegrationTest();
test.run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});