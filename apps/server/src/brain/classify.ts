import type { LlmClient } from '../llm/client';
import { parseJsonish } from './parse';

// 统一的「LLM 判定 → 抽 JSON → 解析 → 兜底」分类骨架。
// 三个 JSON 分类器（farewell / coachCue / memory）同构——一个 SYSTEM_PROMPT + 一次 chat +
// parseJsonish + 一个 parse 纯函数 + 失败兜底——之前各自写了一遍，收敛到这里。
// segmentEmotion 是「只出一个词」的非 JSON 输出，形状不同，不走这里。
// 每个分类器只提供 system、user、parse 纯函数与兜底值，其余（温度 0、try/catch、null 兜底）都在这里。
export async function classifyJson<T>(
  llm: LlmClient,
  model: string,
  opts: {
    system: string;
    user: string;
    maxTokens?: number;
    parse: (o: Record<string, unknown>) => T | null;
    fallback: T;
  },
): Promise<T> {
  try {
    const raw = await llm.chat(
      [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      { model, temperature: 0, maxTokens: opts.maxTokens ?? 100 },
    );
    const o = parseJsonish(raw);
    if (!o) return opts.fallback;
    return opts.parse(o) ?? opts.fallback;
  } catch {
    // 分类失败 → 保守回退（由调用方定义自己的「不触发」兜底，宁可不做也不误做）。
    return opts.fallback;
  }
}
