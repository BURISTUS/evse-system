#!/usr/bin/env node

const mqtt = require('mqtt');
const Redis = require('ioredis');

console.log('\n🔍 REDIS INTEGRATION TEST\n');

async function testRedis() {
  console.log('1️⃣ Connecting to Redis...');
  const redisSubscriber = new Redis('redis://localhost:6379');
  
  try {
    await redisSubscriber.ping();
    console.log('✓ Redis connected\n');
  } catch (err) {
    console.error('❌ Redis connection failed:', err.message);
    process.exit(1);
  }
  
  const receivedRedisMessages = [];
  
  await redisSubscriber.subscribe('evse_data1', 'evse_data2', 'heartbeat');
  console.log('✓ Subscribed to: evse_data1, evse_data2, heartbeat\n');
  
  redisSubscriber.on('message', (channel, message) => {
    console.log(`\n✅ REDIS MESSAGE RECEIVED!`);
    console.log(`   Channel: ${channel}`);
    console.log(`   Data: ${message.substring(0, 150)}`);
    receivedRedisMessages.push({ channel, message: JSON.parse(message) });
  });
  
  console.log('2️⃣ Connecting to MQTT...');
  const mqttClient = mqtt.connect('mqtt://localhost:1883', {
    connectTimeout: 5000,
  });
  
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('MQTT connection timeout'));
    }, 5000);
    
    mqttClient.on('connect', () => {
      clearTimeout(timeout);
      console.log('✓ MQTT connected\n');
      resolve();
    });
    
    mqttClient.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  }).catch(err => {
    console.error('❌ MQTT connection failed:', err.message);
    console.log('\n💡 Is MQTT broker running? Check with:');
    console.log('   docker ps | grep mosquitto');
    console.log('   OR');
    console.log('   mosquitto_pub -h localhost -t test -m "test"');
    process.exit(1);
  });
  
  console.log('3️⃣ Waiting 3 seconds for NestJS to be ready...\n');
  await sleep(3000);
  
  const deviceId = 99999;
  console.log(`4️⃣ Sending test messages for device ${deviceId}...\n`);
  
  console.log('📝 Sending evse_state (msg_id=16) to /EVSE_REGISTER');
  const registerFrame = createFrame(deviceId, 16);
  mqttClient.publish('/EVSE_REGISTER', registerFrame);
  console.log(`   Frame: ${registerFrame.toString('hex')}`);
  await sleep(3000);
  
  console.log('\n📊 Sending evse_data1 (msg_id=19) to /EVSE/${deviceId}/INBOX');
  const data1Frame = createFrame(deviceId, 19);
  mqttClient.publish(`/EVSE/${deviceId}/INBOX`, data1Frame);
  console.log(`   Frame: ${data1Frame.toString('hex')}`);
  await sleep(3000);
  
  console.log('\n🌡️  Sending evse_data2 (msg_id=20) to /EVSE/${deviceId}/INBOX');
  const data2Frame = createFrame(deviceId, 20);
  mqttClient.publish(`/EVSE/${deviceId}/INBOX`, data2Frame);
  console.log(`   Frame: ${data2Frame.toString('hex')}`);
  await sleep(3000);
  
  console.log('\n⚡ Sending evse_session (msg_id=17) to /EVSE/${deviceId}/INBOX');
  const sessionFrame = createFrame(deviceId, 17);
  mqttClient.publish(`/EVSE/${deviceId}/INBOX`, sessionFrame);
  console.log(`   Frame: ${sessionFrame.toString('hex')}`);
  await sleep(3000);
  
  console.log('\n═══════════════════════════════════════');
  console.log('           RESULTS');
  console.log('═══════════════════════════════════════\n');
  
  console.log(`Total Redis messages: ${receivedRedisMessages.length}\n`);
  
  if (receivedRedisMessages.length > 0) {
    console.log('✅ SUCCESS - Redis is working!\n');
    
    const byChannel = {};
    receivedRedisMessages.forEach(({ channel }) => {
      byChannel[channel] = (byChannel[channel] || 0) + 1;
    });
    
    console.log('Messages by channel:');
    Object.entries(byChannel).forEach(([ch, count]) => {
      console.log(`  ${ch}: ${count}`);
    });
    
    console.log('\n📋 Sample message:');
    const sample = receivedRedisMessages[0];
    console.log(`  Channel: ${sample.channel}`);
    console.log(`  Device:  ${sample.message.device_id}`);
    console.log(`  Data:    ${JSON.stringify(sample.message.data, null, 2).substring(0, 200)}`);
    
  } else {
    console.log('❌ FAIL - No Redis messages received\n');
    
    console.log('🔍 Troubleshooting steps:\n');
    
    console.log('1. Check if NestJS is running:');
    console.log('   ps aux | grep nest');
    console.log('   OR check port: lsof -i :3001\n');
    
    console.log('2. Check NestJS logs:');
    console.log('   tail -f logs/nest.log');
    console.log('   OR if running: yarn start:dev (check console)\n');
    
    console.log('3. Add debug logs to NestJS:');
    console.log('   In src/mqtt/mqtt.service.ts → handleMessage():');
    console.log('   console.log("🔵 MQTT received:", topic, payload.length);\n');
    
    console.log('4. Test MQTT directly:');
    console.log('   Terminal 1: mosquitto_sub -h localhost -t "#" -v');
    console.log('   Terminal 2: mosquitto_pub -h localhost -t test -m "hello"\n');
    
    console.log('5. Test Redis directly:');
    console.log('   Terminal 1: redis-cli MONITOR');
    console.log('   Terminal 2: redis-cli PUBLISH evse_data1 "test"\n');
    
    console.log('6. Check Python DBC Service:');
    console.log('   lsof -i :50051');
    console.log('   grpcurl -plaintext localhost:50051 list\n');
  }
  
  mqttClient.end();
  await redisSubscriber.quit();
  
  process.exit(receivedRedisMessages.length > 0 ? 0 : 1);
}

function createFrame(deviceAddress, messageId) {
  const commAddr = (deviceAddress & 0x1F) | ((messageId & 0x3FF) << 5);
  const frame = Buffer.allocUnsafe(12);
  frame.writeUInt16LE(commAddr, 0);
  
  Buffer.from([0x10, 0x0F, 0x10, 0x88, 0x13, 0x00, 0x00, 0x00]).copy(frame, 2);
  
  frame.writeUInt16LE(0x1234, 10);
  
  return frame;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testRedis().catch(err => {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
});