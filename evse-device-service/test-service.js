const mqtt = require('mqtt');

console.log('🧪 Testing EVSE Device Service...');

const client = mqtt.connect('mqtt://localhost:1883');

client.on('connect', () => {
  console.log('✅ Connected to MQTT broker');
  
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
