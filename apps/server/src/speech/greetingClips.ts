// 招呼语片段缓存：按 voice:lang 预热/落盘，让第一通第一句秒回。
// 从 session.ts 抽出——只管「加载或 TTS 生成片段并缓存」，播放与 transcript 落库仍归 session。
import { streamTTS } from './cosyvoiceRealtime';
import { buildInstruction, tailHint } from './emotionInstruction';
import { concatPcm } from './backchannel';
import { GREETINGS, GREETINGS_EN } from '../persona/greetings';
import { greetingCacheKey, loadGreetingClipsFromDisk, saveGreetingClipsToDisk } from '../greetingCache';

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
