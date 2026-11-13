// 副语言 backchannel（附和）：用户长段倾诉时，教练在自然停顿处小声插一句「嗯 / 对 / 然后呢」，
// 给「被听见感」而不打断用户。服务端在 onUserPcm 单点做静音检测，配合 ASR 的 interim（说到一半）
// 判定「停顿」，到点从预生成片段里挑一句轻声播放（鸭音 gain）。片段按音色缓存（第一版只覆盖已上线 4 位）。
//
// 触发条件：interim 有字（用户在说）+ 连续静音 ≥ silenceMs + 冷却已过 + 每 turn 未超上限。

export const BACKCHANNEL_PHRASES = ['对', '然后呢', '我在听'];

export const BACKCHANNEL_INSTRUCTION =
  '用很轻、很自然的语气说，像在认真听对方说话时轻轻应一声，短促、绝不抢话。';

const SILENCE_RMS = 0.01; // 线性 RMS（~-40dBFS），与 AcousticFeatureExtractor 的阈值一致

export type BackchannelOptions = {
  silenceMs: number;    // 连续静音多久触发（低于 ASR 约 600ms 断句，先 500）
  cooldownMs: number;   // 两次 backchannel 最小间隔
  maxPerTurn: number;   // 每 turn 最多插几句
  gain: number;         // 鸭音音量（0..1）
  minSpeechMs?: number; // 本 turn 连续说了多久才允许插嘴（默认 0 = 一开始就可以）
};

export function concatPcm(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// 判断一段 16kHz Int16 PCM 是否有声（RMS > 阈值）。可单测。
export function hasVoicePcm(chunk: Uint8Array): boolean {
  const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / int16.length) > SILENCE_RMS;
}

export class BackchannelEngine {
  private clips = new Map<string, Uint8Array[]>(); // voice → 与 PHRASES 对齐的片段
  private currentVoice: string | null = null;
  private lastVoicedAt = 0;
  private interimActive = false;
  private lastFiredAt = 0;
  private firedThisTurn = 0;
  private firedThisGap = false;
  private turnStartAt = 0; // 本 turn 用户开始说话的墙钟时间（minSpeechMs 判定用）

  constructor(
    private opts: BackchannelOptions,
    private onEmit: (pcm: Uint8Array, gain: number) => void,
  ) {}

  // 某音色的片段就绪（服务端用 streamTTS 预生成，逐音色缓存）。
  setClips(voice: string, clips: Uint8Array[]): void {
    if (clips.length === 0) return;
    this.clips.set(voice, clips);
  }

  hasClips(voice: string): boolean {
    return this.clips.has(voice);
  }

  setVoice(voice: string): void {
    this.currentVoice = voice;
  }

  // 喂上行 PCM（16kHz），检测静音间隙并触发。
  feedPcm(chunk: Uint8Array): void {
    if (hasVoicePcm(chunk)) {
      this.lastVoicedAt = Date.now();
      this.firedThisGap = false; // 又开始说话了，清掉本轮静音间隙的「已触发」标记
      return;
    }
    const now = Date.now();
    if (
      this.currentVoice !== null &&
      this.interimActive &&
      !this.firedThisGap &&
      now - this.turnStartAt >= (this.opts.minSpeechMs ?? 0) &&
      now - this.lastVoicedAt >= this.opts.silenceMs &&
      now - this.lastFiredAt >= this.opts.cooldownMs &&
      this.firedThisTurn < this.opts.maxPerTurn
    ) {
      this.firedThisGap = true;
      this.fire();
    }
  }

  // ASR 出 interim（用户在说、还没说完）。
  onInterim(): void {
    if (!this.interimActive) this.turnStartAt = Date.now(); // 新一轮开说，记起点
    this.interimActive = true;
  }

  // 一轮结束（ASR final）：清 interim + 重置本轮计数。
  onTurnEnd(): void {
    this.interimActive = false;
    this.firedThisTurn = 0;
    this.turnStartAt = 0;
  }

  // 新通话 / 被打断：复位状态。
  reset(): void {
    this.interimActive = false;
    this.firedThisTurn = 0;
    this.firedThisGap = false;
    this.lastFiredAt = 0;
    this.turnStartAt = 0;
  }

  private fire(): void {
    const clips = this.currentVoice ? this.clips.get(this.currentVoice) : undefined;
    if (!clips || clips.length === 0) return;
    const pick = clips[Math.floor(Math.random() * clips.length)];
    this.lastFiredAt = Date.now();
    this.firedThisTurn++;
    this.onEmit(pick, this.opts.gain);
  }
}
