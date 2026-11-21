// 情绪链的「判定 + 平滑」纯函数（Affect 到手之后的那段，全部可单测、零副作用）。
// 与 decide.ts 的分工：decide.ts 管「打分」（call1，一次 LLM 调用）；本文件管「打分之后怎么判」——
//   decideMode     —— 由 Affect + 安全旗标判 mode（casual/careful），黄旗/红旗硬执行
//   decideStance   —— 由支配度判 stance（低支配 → 只陪不抛清单）
//   decideEmotion  —— 由 Affect + 主导发声判本轮回应情绪（通用镜像，所有陪伴者共用）
//   updateMood     —— mood = affect 的多轮 EMA（会话级心境轨迹）
// mode 的防抖状态机在 modeTracker.ts（有状态），不在本文件。
import type { Affect, EmotionTag, Mode, MoodState, SafetyAction, Stance } from '@mirror/contracts';

// —— 判 mode：纯函数，黄旗/红旗阈值硬执行（可单测） ——
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

// mood = affect 的多轮 EMA：mood_t = α·affect_t + (1-α)·mood_{t-1}，α≈0.6。
const ALPHA = 0.6;

export function updateMood(prev: MoodState | null, affect: Affect): MoodState {
  const v = prev ?? { valence: 0, arousal: 0, dominance: 0 };
  return {
    valence: round2(ALPHA * affect.valence + (1 - ALPHA) * v.valence),
    arousal: round2(ALPHA * affect.arousal + (1 - ALPHA) * v.arousal),
    dominance: round2(ALPHA * affect.dominance + (1 - ALPHA) * v.dominance),
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
