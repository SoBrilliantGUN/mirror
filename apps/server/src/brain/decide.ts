// call1 打分：LLM 融合「文本 + 副语言（声学 z-score）+ 非言语发声（哭/笑）」，给本轮打三维分 Affect。
// 打分之后的「怎么判」（decideMode / decideStance / decideEmotion）与心境平滑（updateMood）已拆到 emotion.ts，
// 这里只留「打分 + 解析」，一条 LLM 调用 + 一个容错解析。
import type { AcousticFeatures, Affect, MoodState, VocalizationEvent } from '@mirror/contracts';
import type { LlmClient } from '../llm/client';
import { SCORE_SYSTEM_PROMPT, buildScoreUserPrompt } from './prompts';
import { parseJsonish } from './parse';

// —— call1 打分（非流式，小输出） ——
export async function scoreAffect(
  llm: LlmClient,
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
