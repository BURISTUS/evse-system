#!/usr/bin/env node

const mqtt = require('mqtt');

// ========================
// CRC16-ARC (Modbus) расчёт
// ========================
function calculateCRC16(data) {
  let crc = 0x0000;
  
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      if (crc & 1) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  
  return crc & 0xFFFF;
}

// ========================
// Создание фрейма с валидным CRC
// ========================
function createFrame(deviceAddress, messageId, canData = null) {
  // Дефолтные данные для разных типов сообщений
  if (!canData) {
    const defaultPayloads = {
      16: Buffer.from([0x03, 0x12, deviceAddress, 0, 0x00, 0x00, 0x00, 0x00]), // evse_state
      17: Buffer.from([0x2A, 0x00, 0x00, 0x7D, 0x00, 0x88, 0x13, 0x00]),       // evse_session
      19: Buffer.from([0x10, 0x0F, 0x10, 0x00, 0x00, 0x00, 0x9C, 0x14]),       // evse_data1
      20: Buffer.from([0xE6, 0x00, 0xEB, 0x00, 0xE8, 0x00, 0x2D, 0x26]),       // evse_data2
    };
    canData = defaultPayloads[messageId] || Buffer.alloc(8);
  }

  // Формируем COMM_ADDR (2 байта, little-endian)
  const commAddr = (deviceAddress & 0x1F) | ((messageId & 0x3FF) << 5);
  const commAddrBytes = Buffer.allocUnsafe(2);
  commAddrBytes.writeUInt16LE(commAddr, 0);

  // Убедимся что CAN_DATA ровно 8 байт
  const paddedCanData = Buffer.alloc(8);
  canData.copy(paddedCanData, 0, 0, Math.min(canData.length, 8));

  // Считаем CRC16 от COMM_ADDR + CAN_DATA
  const crcData = Buffer.concat([commAddrBytes, paddedCanData]);
  const crc = calculateCRC16(crcData);
  const crcBytes = Buffer.allocUnsafe(2);
  crcBytes.writeUInt16LE(crc, 0);

  // Итоговый фрейм: COMM_ADDR (2) + CAN_DATA (8) + CRC16 (2) = 12 байт
  return Buffer.concat([commAddrBytes, paddedCanData, crcBytes]);
}

// ========================
// MAIN SCRIPT
// ========================
console.log('\n🚀 EVSE Device MQTT Test Script');
console.log('================================\n');

const BROKER_URL = 'mqtt://46.148.233.150:1884';
const DEVICE_ID = 5;

const client = mqtt.connect(BROKER_URL, {
  clientId: `test-device-${DEVICE_ID}-${Date.now()}`,
  username: 'evse_device', 
  password: 'evse_device_password', 
});

// Подписываемся на топик с распарсенными данными
const PARSED_TOPIC = `/DBC_PARSED/${DEVICE_ID}`;

client.on('connect', async () => {
  console.log(`✅ Connected to MQTT broker: ${BROKER_URL}\n`);

  // Подписываемся на ответы
  client.subscribe(PARSED_TOPIC, (err) => {
    if (err) {
      console.error(`❌ Failed to subscribe to ${PARSED_TOPIC}`);
    } else {
      console.log(`📡 Subscribed to: ${PARSED_TOPIC}\n`);
    }
  });

  console.log('📝 STEP 1: Device Registration');
  console.log('─'.repeat(50));
  
  const registerFrame = createFrame(DEVICE_ID, 16); // evse_state
  console.log(`Publishing to: /EVSE_REGISTER`);
  console.log(`Frame hex: ${registerFrame.toString('hex').toUpperCase()}`);
  console.log(`Frame length: ${registerFrame.length} bytes`);
  
  client.publish('/EVSE_REGISTER', registerFrame);
  
  await sleep(3000);

  console.log('\n⚡ STEP 2: Start Charging Session');
  console.log('─'.repeat(50));
  
  const sessionFrame = createFrame(DEVICE_ID, 17); // evse_session
  console.log(`Publishing to: /EVSE/${DEVICE_ID}/INBOX`);
  console.log(`Frame hex: ${sessionFrame.toString('hex').toUpperCase()}`);
  
  client.publish(`/EVSE/${DEVICE_ID}/INBOX`, sessionFrame);
  
  await sleep(3000);

  console.log('\n📊 STEP 3: Sending Metrics (evse_data1)');
  console.log('─'.repeat(50));
  
  const data1Frame = createFrame(DEVICE_ID, 19); // evse_data1
  console.log(`Publishing to: /EVSE/${DEVICE_ID}/INBOX`);
  console.log(`Frame hex: ${data1Frame.toString('hex').toUpperCase()}`);
  
  client.publish(`/EVSE/${DEVICE_ID}/INBOX`, data1Frame);
  
  await sleep(3000);

  console.log('\n🌡️  STEP 4: Sending Metrics (evse_data2)');
  console.log('─'.repeat(50));
  
  const data2Frame = createFrame(DEVICE_ID, 20); // evse_data2
  console.log(`Publishing to: /EVSE/${DEVICE_ID}/INBOX`);
  console.log(`Frame hex: ${data2Frame.toString('hex').toUpperCase()}`);
  
  client.publish(`/EVSE/${DEVICE_ID}/INBOX`, data2Frame);
  
  await sleep(5000);

  console.log('\n✅ All messages sent!');
  console.log('Check the received parsed messages above ↑\n');
  
  client.end();
});

// Слушаем входящие сообщения
client.on('message', (topic, payload) => {
  console.log(`\n📨 RECEIVED PARSED DATA:`);
  console.log(`   Topic: ${topic}`);
  
  try {
    const parsed = JSON.parse(payload.toString());
    console.log(`   Device: ${parsed.device_address}`);
    console.log(`   Message: ${parsed.message_name}`);
    console.log(`   CRC Valid: ${parsed.crc_valid}`);
    console.log(`   Signals:`);
    console.log(JSON.stringify(parsed.signals, null, 6));
  } catch (e) {
    console.log(`   Raw: ${payload.toString()}`);
  }
});

client.on('error', (error) => {
  console.error(`❌ MQTT Error: ${error.message}`);
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}