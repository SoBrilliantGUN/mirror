import type { RawData } from 'ws';

// ws 的 message data 类型是 RawData（Buffer | ArrayBuffer | Buffer[]），统一转成 Buffer。
export function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
