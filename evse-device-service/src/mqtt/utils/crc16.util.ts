export class CRC16 {
    static calculate(data: Buffer): number {
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
  
    static verify(data: Buffer, expectedCrc: number): boolean {
      const calculated = this.calculate(data);
      return calculated === expectedCrc;
    }
  
    static format(crc: number): string {
      return `0x${crc.toString(16).toUpperCase().padStart(4, '0')}`;
    }
  }