// 招呼语片段缓存：按 voice:lang 预热/落盘，让第一通第一句秒回。
// 从 session.ts 抽出——只管「加载或 TTS 生成片段并缓存」，播放与 transcript 落库仍归 session。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { streamTTS } from './cosyvoiceRealtime';
import { buildInstruction, tailHint } from './emotionInstruction';
import { concatPcm } from './backchannel';
import { GREETINGS, GREETINGS_EN } from '../persona/greetings';

export type GreetingTts = {
  wsUrl: string;
  apiKey: string;
  model: string;
};

export class GreetingClipCache {
  private clips = new Map<string, Uint8Array[]>();
  private phrases = new Map<string, string[]>();
  private inFlight = new Map<string, Promise<void>>();

  constructor(private readonly tts: GreetingTts) {}

  has(key: string): boolean {
    return this.clips.has(key);
  }

  // 预热某 voice:lang 的招呼语片段：磁盘缓存命中则直接加载，否则 TTS 生成并落盘。
  async ensure(voice: string, name: string, voiceTint: string, rate: number, lang: 'zh' | 'en' = 'zh'): Promise<void> {
    const key = `${voice}:${lang}`;
    if (this.clips.has(key)) return;
    const inflight = this.inFlight.get(key);
    if (inflight) return inflight;

    const task = (async () => {
      const phrases = (lang === 'en' ? GREETINGS_EN[name] : GREETINGS[name]) ?? ['喂，你好呀', '嗨，是我', '你好呀'];
      this.phrases.set(key, phrases);
      const cacheFile = greetingCacheKey(voice, phrases);
      const fromDisk = loadGreetingClipsFromDisk(cacheFile);
      if (fromDisk) {
        this.clips.set(key, fromDisk);
        console.log(`[greeting] ${name}${lang === 'en' ? '(EN)' : ''} 招呼语已从磁盘缓存加载（${fromDisk.length} 句）`);
        return;
      }
      const clips: Uint8Array[] = [];
      for (const phrase of phrases) {
        const parts: Uint8Array[] = [];
        for await (const pcm of streamTTS({
          wsUrl: this.tts.wsUrl,
          apiKey: this.tts.apiKey,
          model: this.tts.model,
          voice,
          instruction: buildInstruction('natural', voiceTint) + tailHint(phrase),
          text: phrase,
          rate,
        })) parts.push(pcm);
        clips.push(concatPcm(parts));
      }
      this.clips.set(key, clips);
      saveGreetingClipsToDisk(cacheFile, clips);
      console.log(`[greeting] ${name}${lang === 'en' ? '(EN)' : ''} 招呼语就绪（${clips.length} 句）`);
    })();

    this.inFlight.set(key, task);
    try {
      await task;
    } finally {
      this.inFlight.delete(key);
    }
  }

  // 随机取一句已缓存片段（连同其文案）。无则返回 null。
  pick(key: string): { clip: Uint8Array; phrase: string } | null {
    const clips = this.clips.get(key);
    if (!clips || clips.length === 0) return null;
    const idx = Math.floor(Math.random() * clips.length);
    return { clip: clips[idx], phrase: this.phrases.get(key)?.[idx] ?? '' };
  }
}

// ============================================================
// 招呼语磁盘缓存（原 src/greetingCache.ts 并入）——序列化 / 落盘 / 读盘 / 缓存 key。
// 纯函数、无会话状态；被上面的 GreetingClipCache 用来避免每次重启都重新烧 TTS。
// ============================================================

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
