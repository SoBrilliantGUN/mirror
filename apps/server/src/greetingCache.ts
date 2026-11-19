// 招呼语音频的磁盘缓存：序列化 + 落盘/读盘 + 缓存 key（带招呼语文本哈希）。
// 纯函数、无会话状态；被 CallSession 用来避免每次重启都重新烧 TTS。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// 桌面版由 Electron 主进程注入到 userData 下；`npm start` 仍用仓库相对路径。
export function greetingCacheDir(): string {
  return process.env.GREETING_CACHE_DIR ?? join(process.cwd(), 'apps', 'server', '.greetings-cache');
}

// 序列化：uint32 片段数 + 每个片段的 uint32 字节长 + 原始 PCM 拼接。
export function serializeGreetingClips(clips: Uint8Array[]): Buffer {
  const header = Buffer.alloc(4 + clips.length * 4);
  header.writeUInt32LE(clips.length, 0);
  clips.forEach((c, i) => header.writeUInt32LE(c.length, 4 + i * 4));
  return Buffer.concat([header, ...clips.map((c) => Buffer.from(c))]);
}

export function deserializeGreetingClips(buf: Buffer): Uint8Array[] {
  const count = buf.readUInt32LE(0);
  const clips: Uint8Array[] = [];
  let off = 4 + count * 4;
  for (let i = 0; i < count; i++) {
    const len = buf.readUInt32LE(4 + i * 4);
    clips.push(new Uint8Array(buf.subarray(off, off + len)));
    off += len;
  }
  return clips;
}

// 磁盘缓存 key 带招呼语文本哈希：改了招呼语（GREETINGS 文本变）哈希就变，自动失效旧缓存，
// 避免「改了招呼语却还读到旧音频（比如旧缓存里带『上午好/中午好』这类时间词）」。旧文件成为孤儿缓存，无害。
export function greetingCacheKey(voice: string, phrases: string[]): string {
  const digest = createHash('sha1').update(phrases.join('\n')).digest('hex').slice(0, 12);
  return `${voice}.${digest}.pcm`;
}

export function loadGreetingClipsFromDisk(filename: string): Uint8Array[] | null {
  const file = join(greetingCacheDir(), filename);
  if (!existsSync(file)) return null;
  try {
    const clips = deserializeGreetingClips(readFileSync(file));
    return clips.length > 0 ? clips : null;
  } catch (e) {
    console.warn('[greeting] 读磁盘缓存失败，将重新合成：', e);
    return null;
  }
}

export function saveGreetingClipsToDisk(filename: string, clips: Uint8Array[]): void {
  try {
    mkdirSync(greetingCacheDir(), { recursive: true });
    writeFileSync(join(greetingCacheDir(), filename), serializeGreetingClips(clips));
  } catch (e) {
    console.warn('[greeting] 写磁盘缓存失败（不影响内存缓存）：', e);
  }
}
