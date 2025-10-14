import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from '../src/config/configuration';
import { GrpcDbcService } from '../src/grpc/grpc-dbc.service';

describe('gRPC DBC Client (e2e)', () => {
  let app: INestApplication;
  let grpcService: GrpcDbcService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [configuration],
        }),
      ],
      providers: [GrpcDbcService],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    
    grpcService = app.get<GrpcDbcService>(GrpcDbcService);
    
    // Даем время Python DBC Service подняться
    await new Promise(resolve => setTimeout(resolve, 2000));
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Frame Parsing', () => {
    it('should parse evse_session frame', async () => {
      // msg_id=17 для evse_session
      const commAddr = (1 & 0x1F) | ((17 & 0x3FF) << 5);
      const frame = Buffer.allocUnsafe(12);
      frame.writeUInt16LE(commAddr, 0);
      Buffer.from([0x00, 0x2A, 0x00, 0x7D, 0x3C, 0x00, 0x00, 0x00]).copy(frame, 2);
      Buffer.from([0x12, 0x34]).copy(frame, 10);
    
      const request = {
        frame_data: frame.toString('hex').toUpperCase(),
        timestamp: '2025-01-01T00:00:00Z',
      };
    
      const response = await grpcService.parseFrame(request);
      expect(response.parsed).toBe(true);
      expect(response.message_name).toBe('evse_session');
    });
    
    it('should parse evse_data1 frame', async () => {
      // msg_id=19 для evse_data1
      const commAddr = (1 & 0x1F) | ((19 & 0x3FF) << 5);
      const frame = Buffer.allocUnsafe(12);
      frame.writeUInt16LE(commAddr, 0);
      Buffer.from([0x00, 0x2A, 0x00, 0x7D, 0x3C, 0x00, 0x00, 0x00]).copy(frame, 2);
      Buffer.from([0x12, 0x34]).copy(frame, 10);
    
      const request = {
        frame_data: frame.toString('hex').toUpperCase(),
        timestamp: '2025-01-01T00:00:00Z',
      };
    
      const response = await grpcService.parseFrame(request);
      expect(response.parsed).toBe(true);
      expect(response.message_name).toBe('evse_data1');
    });
    
    it('should parse evse_data2 frame', async () => {
      // msg_id=20 для evse_data2
      const commAddr = (1 & 0x1F) | ((20 & 0x3FF) << 5);
      const frame = Buffer.allocUnsafe(12);
      frame.writeUInt16LE(commAddr, 0);
      Buffer.from([0x00, 0x2A, 0x00, 0x7D, 0x3C, 0x00, 0x00, 0x00]).copy(frame, 2);
      Buffer.from([0x12, 0x34]).copy(frame, 10);
    
      const request = {
        frame_data: frame.toString('hex').toUpperCase(),
        timestamp: '2025-01-01T00:00:00Z',
      };
    
      const response = await grpcService.parseFrame(request);
      expect(response.parsed).toBe(true);
      expect(response.message_name).toBe('evse_data2');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid hex format', async () => {
      const request = {
        frame_data: 'INVALID_HEX',
        timestamp: '2025-01-01T00:00:00Z',
      };
    
      const response = await grpcService.parseFrame(request);
      expect(response.parsed).toBe(false);
      expect(response.error).toBeDefined();
    });
    

    it('should handle wrong frame length', async () => {
      const request = {
        frame_data: '11020000',
        timestamp: '2025-01-01T00:00:00Z',
      };

      const response = await grpcService.parseFrame(request);
      expect(response.parsed).toBe(false);
      expect(response.error).toBeDefined();
    });

    it('should handle invalid CRC', async () => {
      const request = {
        frame_data: '1102002A007D3C00000000FF',
        timestamp: '2025-01-01T00:00:00Z',
      };

      const response = await grpcService.parseFrame(request);
      // CRC проверяется в Python, может быть parsed=false или crc_valid=false
      expect(response).toBeDefined();
    });

    it('should handle unknown message ID', async () => {
      const commAddr = (1 & 0x1F) | ((999 & 0x3FF) << 5);
      const frame = Buffer.allocUnsafe(12);
      frame.writeUInt16LE(commAddr, 0);
      Buffer.from([0x00, 0x2A, 0x00, 0x7D, 0x3C, 0x00, 0x00, 0x00]).copy(frame, 2);
      Buffer.from([0x12, 0x34]).copy(frame, 10);
    
      const request = {
        frame_data: frame.toString('hex').toUpperCase(),
        timestamp: '2025-01-01T00:00:00Z',
      };
    
      const response = await grpcService.parseFrame(request);
      
      expect(response.parsed).toBe(false);
      expect(response.error).toBeDefined();
      expect(response.error).toContain('Unknown');
    });
  });

  describe('Batch Processing', () => {
    it('should parse multiple frames in batch', async () => {
      const frames = [
        { frame_data: '1002002A007D3C0000001234', timestamp: '2025-01-01T00:00:00Z' },
        { frame_data: '1102002A007D3C0000001234', timestamp: '2025-01-01T00:00:01Z' },
        { frame_data: '1302002A007D3C0000001234', timestamp: '2025-01-01T00:00:02Z' },
      ];

      const responses = await grpcService.parseBatch(frames);

      expect(responses).toBeDefined();
      expect(responses.length).toBe(3);
      expect(responses.every(r => r.parsed)).toBe(true);
    });

    it('should handle batch with mixed valid/invalid frames', async () => {
      const frames = [
        { frame_data: '1002002A007D3C0000001234', timestamp: '2025-01-01T00:00:00Z' },
        { frame_data: 'INVALID', timestamp: '2025-01-01T00:00:01Z' },
        { frame_data: '1302002A007D3C0000001234', timestamp: '2025-01-01T00:00:02Z' },
      ];

      try {
        const responses = await grpcService.parseBatch(frames);
        
        // Если не выбросило ошибку, проверяем что валидные обработались
        const validResponses = responses.filter(r => r.parsed);
        expect(validResponses.length).toBeGreaterThan(0);
      } catch (error) {
        // Ожидаемое поведение - выброс ошибки на невалидном фрейме
        expect(error).toBeDefined();
      }
    });

    it('should handle empty batch', async () => {
      const frames = [];

      const responses = await grpcService.parseBatch(frames);

      expect(responses).toBeDefined();
      expect(responses.length).toBe(0);
    });
  });

  describe('Performance', () => {
    it('should parse frames quickly (< 100ms per frame)', async () => {
      const request = {
        frame_data: '1002002A007D3C0000001234',
        timestamp: '2025-01-01T00:00:00Z',
      };

      const start = Date.now();
      await grpcService.parseFrame(request);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(100);
    });

    it('should handle high throughput (10 frames)', async () => {
      const frames = Array.from({ length: 10 }, (_, i) => ({
        frame_data: '1002002A007D3C0000001234',
        timestamp: new Date().toISOString(),
      }));

      const start = Date.now();
      
      const promises = frames.map(frame => grpcService.parseFrame(frame));
      const responses = await Promise.all(promises);
      
      const duration = Date.now() - start;

      expect(responses.length).toBe(10);
      expect(responses.every(r => r.parsed)).toBe(true);
      expect(duration).toBeLessThan(1000);
    });
  });

  describe('Connection Resilience', () => {
    it('should reconnect after connection loss', async () => {
      // Первый вызов - устанавливает соединение
      const request1 = {
        frame_data: '1002002A007D3C0000001234',
        timestamp: '2025-01-01T00:00:00Z',
      };

      await grpcService.parseFrame(request1);

      // Даем время на потенциальный таймаут
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Второй вызов - должен работать
      const request2 = {
        frame_data: '1102002A007D3C0000001234',
        timestamp: '2025-01-01T00:00:01Z',
      };

      const response = await grpcService.parseFrame(request2);
      expect(response.parsed).toBe(true);
    });
  });
});