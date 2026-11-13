import type { AcousticFeatures } from '@mirror/contracts';
import { YIN } from 'pitchfinder';

// L0 副语言特征提取：流式喂 16kHz PCM，回合结束时产出「相对她自己基线的 z-score」。
// 四个特征：响度(loudness) / 音高(pitch) / 语速(rate) / 停顿(pause)。
// z-score 基线 = 本会话她自己最近若干轮的 raw 值（mean + std），冷启动（样本 <2）返回 0。

const SAMPLE_RATE = 16000;
const FRAME = 320; // 20ms @16kHz
const PITCH_WINDOW = 640; // 40ms：YIN 至少两个基频周期才稳
const SILENCE_RMS = 0.01; // 线性 RMS 阈值（约 -40dBFS），低于算静音
const BASELINE_KEEP = 32; // 基线保留最近 N 轮 raw 值
const GENDER_MIN_FRAMES = 60;    // 有声帧下限，够判性别（≈1.2s 有声语音）
const GENDER_MALE_MAX_HZ = 160;  // 中位 F0 低于此 → 男
const GENDER_FEMALE_MIN_HZ = 185; // 中位 F0 高于此 → 女
const GENDER_PITCH_CAP = 5000;   // 会话级 F0 缓存上限（够稳即可，控内存）

type FeatureKey = 'rate' | 'pitch' | 'loudness' | 'pause';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export class AcousticFeatureExtractor {
  private detectPitch: (buf: Float32Array) => number | null;
  private pending = new Float32Array(0); // 不满一帧的残余样本
  private pitchBuf = new Float32Array(0); // 最近 PITCH_WINDOW 样本（估 F0 用）

  // 回合级累加
  private frameCount = 0;
  private voicedCount = 0; // rms 超阈值的帧数（判停顿）
  private pitchCount = 0; // 得到有效 F0 的帧数（判音高）
  private sumLoudness = 0; // dBFS 累加
  private sumPitch = 0; // Hz 累加（仅有效 F0）
  private sessionPitches: number[] = []; // 会话级有声 F0（判性别用，reset() 才清）

  // 会话级 z-score 基线
  private baseline: Record<FeatureKey, number[]> = { rate: [], pitch: [], loudness: [], pause: [] };

  constructor() {
    this.detectPitch = YIN({ sampleRate: SAMPLE_RATE });
  }

  // 喂一段 Int16 字节流（16kHz 单声道，与 ASR 同一份）。
  push(chunk: Uint8Array): void {
    const int16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;

    const merged = new Float32Array(this.pending.length + f32.length);
    merged.set(this.pending, 0);
    merged.set(f32, this.pending.length);
    this.pending = merged;

    while (this.pending.length >= FRAME) {
      this.processFrame(this.pending.subarray(0, FRAME));
      this.pending = this.pending.subarray(FRAME);
    }
  }

  // 回合结束：聚合本回合 raw 值 → 四个 z-score，并更新会话基线。
  // text 为空（纯哭/纯笑）时不产语速信号（rateZ=0，不更新 rate 基线）。
  finalize(text: string): AcousticFeatures {
    const n = this.frameCount;
    const durSec = (n * FRAME) / SAMPLE_RATE;
    const loudness = n ? this.sumLoudness / n : -60;
    const pitch = this.pitchCount ? this.sumPitch / this.pitchCount : 0;
    const pause = n ? (n - this.voicedCount) / n : 0;
    const hasText = text.trim().length > 0;
    const rate = hasText ? text.trim().length / Math.max(durSec, 0.01) : 0;

    const out: AcousticFeatures = {
      rateZ: hasText ? this.z('rate', rate) : 0,
      pitchZ: this.pitchCount ? this.z('pitch', pitch) : 0,
      loudnessZ: n ? this.z('loudness', loudness) : 0,
      pauseZ: n ? this.z('pause', pause) : 0,
    };

    this.resetTurn();
    return out;
  }

  // 从会话级有声 F0 中位数判性别：样本不够或落在中间地带 → null（不判、保持中性）。
  detectGender(): '男' | '女' | null {
    if (this.sessionPitches.length < GENDER_MIN_FRAMES) return null;
    const sorted = [...this.sessionPitches].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median < GENDER_MALE_MAX_HZ) return '男';
    if (median > GENDER_FEMALE_MIN_HZ) return '女';
    return null;
  }

  // 整段通话结束（挂断）：清空基线，下通重新标定。
  reset(): void {
    this.resetTurn();
    this.baseline = { rate: [], pitch: [], loudness: [], pause: [] };
    this.pending = new Float32Array(0);
    this.pitchBuf = new Float32Array(0);
    this.sessionPitches = [];
  }

  private processFrame(frame: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const voiced = rms > SILENCE_RMS;

    this.frameCount++;
    this.sumLoudness += 20 * Math.log10(rms + 1e-6);
    if (voiced) this.voicedCount++;

    // 滚动 pitch 窗口，voiced 且窗口够长才估 F0
    const merged = new Float32Array(this.pitchBuf.length + frame.length);
    merged.set(this.pitchBuf, 0);
    merged.set(frame, this.pitchBuf.length);
    this.pitchBuf = merged.length > PITCH_WINDOW ? merged.subarray(merged.length - PITCH_WINDOW) : merged;

    if (voiced && this.pitchBuf.length >= PITCH_WINDOW) {
      const hz = this.detectPitch(this.pitchBuf);
      if (hz !== null && hz > 60 && hz < 500) {
        this.pitchCount++;
        this.sumPitch += hz;
        if (this.sessionPitches.length < GENDER_PITCH_CAP) this.sessionPitches.push(hz);
      }
    }
  }

  // z = (x - mean) / std，样本 <2 或 std≈0 时返回 0。每次把 x 纳入基线。
  private z(key: FeatureKey, x: number): number {
    const arr = this.baseline[key];
    arr.push(x);
    if (arr.length > BASELINE_KEEP) arr.shift();
    if (arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    const std = Math.sqrt(variance);
    if (std < 1e-9) return 0;
    return clamp((x - mean) / std, -3, 3);
  }

  private resetTurn(): void {
    this.frameCount = 0;
    this.voicedCount = 0;
    this.pitchCount = 0;
    this.sumLoudness = 0;
    this.sumPitch = 0;
  }
}
