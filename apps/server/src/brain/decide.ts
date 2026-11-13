import type { Affect, EmotionTag, Mode, SafetyAction, Stance, VoiceConfig } from '@mirror/contracts';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

// 判 mode：纯函数，黄旗/红旗阈值硬执行（可单测）。
export function decideMode(affect: Affect, safety: SafetyAction): Mode {
  if (safety.level >= 1) return 'careful';
  if (affect.valence < -0.25) return 'careful';
  if (affect.valence < 0 && affect.arousal > 0.4 && affect.dominance < 0) return 'careful';
  if (affect.incongruence) return 'careful';
  return 'casual';
}

// stance：由支配度驱动（低支配 → 只陪不抛清单）。
export function decideStance(affect: Affect): Stance {
  return affect.dominance < 0 ? 'accompany' : 'guide';
}

// voiceConfig：基底 × 唤醒修正（安抚：唤醒越高越放慢）。
export function decideVoiceConfig(mode: Mode, affect: Affect): VoiceConfig {
  const base = mode === 'careful'
    ? { speed: 0.78, energy: 0.82 }
    : { speed: 1.0, energy: 1.0 };
  const arousal = clamp(affect.arousal, 0, 2);
  const speed = base.speed * (1 - 0.10 * (arousal / 2));
  return { speed: round2(speed), energy: base.energy, pauseMore: mode === 'careful' };
}

// 通用镜像：由对方情绪（affect）决定回应方向。所有陪伴者共用。
// dominantVocal：本轮非言语发声的主导类型（哭/笑，聚合加权判定）——确定性覆盖，优先于通用镜像。
export function decideEmotion(affect: Affect, dominantVocal?: 'cry' | 'laugh' | null): EmotionTag {
  if (dominantVocal === 'cry') return 'tender';        // 哭 → 心疼安慰
  if (dominantVocal === 'laugh') return 'warm';        // 笑 → 一起开心
  if (affect.valence > 0.25) return 'warm';             // 开心 → 轻快温暖
  if (affect.valence < -0.25) {
    return affect.arousal > 0.4 ? 'steady' : 'tender';  // 激动→安抚 / 悲伤→心疼
  }
  return 'natural';                                     // 平常 → 自然
}
