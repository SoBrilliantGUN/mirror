// 情绪与模式判定（一段数据流，全部纯函数可单测，除 scoreAffect 是一次 LLM 调用）：
//   scoreAffect    —— call1：LLM 融合文本 + 副语言 + 非言语发声（哭/笑），打三维分（Affect）
//   decideMode     —— 由 Affect + 安全旗标判 mode（casual/careful），黄旗/红旗硬执行
//   decideStance   —— 由支配度判 stance（低支配 → 只陪不抛清单）
//   decideEmotion  —— 由 Affect + 主导发声判本轮回应情绪（通用镜像，所有陪伴者共用）
// 心境（mood，affect 的多轮 EMA）在 mood.ts；mode 的防抖状态机在 modeTracker.ts。
import type {
  AcousticFeatures,
  Affect,
  EmotionTag,
  Mode,
  MoodState,
  SafetyAction,
  Stance,
  VocalizationEvent,
} from '@mirror/contracts';
import type { DeepSeek } from '../llm/deepseek';
import { SCORE_SYSTEM_PROMPT, buildScoreUserPrompt } from './prompts';
import { parseJsonish } from './parse';

// —— call1 打分（非流式，小输出） ——
export async function scoreAffect(
  llm: DeepSeek,
  model: string,
  input: { text: string; acoustic: AcousticFeatures; mood: MoodState | null; vocalizations?: VocalizationEvent[] },
): Promise<Affect> {
  const content = await llm.chat(
    [
      { role: 'system', content: SCORE_SYSTEM_PROMPT },
      { role: 'user', content: buildScoreUserPrompt(input) },
    ],
    { model, temperature: 0, maxTokens: 100 },
  );
  return parseAffect(content);
}

const clampScore = (x: number) => Math.min(2, Math.max(-2, x));

// 容错：模型可能包 markdown 代码块或前后有杂字。
export function parseAffect(raw: string): Affect {
  const o = parseJsonish(raw);
  if (!o) throw new Error(`打分解析失败，原始输出：${raw}`);
  const num = (v: unknown, fallback = 0) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    valence: clampScore(num(o.valence)),
    arousal: clampScore(num(o.arousal)),
    dominance: clampScore(num(o.dominance)),
    incongruence: o.incongruence === true || o.incongruence === 'true',
  };
}

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
