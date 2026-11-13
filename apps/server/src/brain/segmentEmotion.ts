import type { EmotionTag } from '@mirror/contracts';
import type { DeepSeek } from '../llm/deepseek';

// 逐句情绪（B2）：生成后对每个 segment 跑一次轻量分类，把 turn 级 emotion 细到句级，
// 让多句回复能「一句暖、一句稳」。温度 0、只出一个标签、~100ms 级；失败回退本轮基调，不阻断对话。
// 方案「生成后分类」：不动流式生成链路，用一次小调用换逐句的情绪差异。

const SEGMENT_EMOTION_SYSTEM = `你是情绪标签器。读「这一句回复 + 本轮语气基调」，判断这一句该用什么语气。只输出一个词。

- warm：轻快温暖、带笑意
- tender：温柔心疼、放软
- steady：沉稳镇定、给确定感
- natural：自然口语、不特别

只输出 warm / tender / steady / natural 之一，不要别的。`;

export async function classifySegmentEmotion(
  llm: DeepSeek,
  model: string,
  segment: string,
  base: EmotionTag,
): Promise<EmotionTag> {
  try {
    const raw = await llm.chat(
      [
        { role: 'system', content: SEGMENT_EMOTION_SYSTEM },
        { role: 'user', content: `本轮基调：${base}\n这一句：${segment}` },
      ],
      { model, temperature: 0, maxTokens: 10 },
    );
    return parseEmotionTag(raw) ?? base;
  } catch {
    return base; // 分类失败回退本轮基调，不阻断
  }
}

// 纯函数：抽第一个合法标签，非法/缺失返回 null。可单测。
export function parseEmotionTag(raw: string): EmotionTag | null {
  const m = raw.match(/\b(warm|tender|steady|natural)\b/);
  return m ? (m[1] as EmotionTag) : null;
}
