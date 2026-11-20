import type { MemoryKind } from '@mirror/contracts';
import type { DeepSeek } from '../llm/deepseek';
import { classifyJson } from './classify';
import { parseEnum, parseJsonish } from './parse';
import { MEMORY_KIND_GLOSS } from './memoryTaxonomy';

// 记忆分类器：写入时用 LLM（temperature=0）确定性分类，替代「信任 Agent 自报 kind」。
// 参考 kima 的 memory_classifier.py——四型（约束/事实/偏好/情节）不能靠 Agent 随手挑，
// 否则一条红线被当事实写进去、走向量 top-k 就被相似度阈值漏掉。失败回退 null（信任自报）。

const CLASSIFY_SYSTEM_PROMPT = `你是记忆分类助手。把传入的记忆文本分类为五种类型之一，只输出 JSON，不要解释。

类型：
${MEMORY_KIND_GLOSS}

只输出这个 JSON：
{"memory_type": "constraint" | "fact" | "preference" | "episodic" | "profile"}`;

const MEMORY_KINDS = ['constraint', 'fact', 'preference', 'episodic', 'profile'] as const;

function parseMemoryTypeObj(o: Record<string, unknown>): MemoryKind | null {
  return parseEnum(o.memory_type, MEMORY_KINDS);
}

export async function classifyMemory(
  llm: DeepSeek,
  model: string,
  raw: string,
): Promise<MemoryKind | null> {
  return classifyJson(llm, model, {
    system: CLASSIFY_SYSTEM_PROMPT,
    user: raw,
    maxTokens: 100,
    parse: parseMemoryTypeObj,
    // LLM 分类失败 → 回退 null（信任 Agent 自报 kind，不静默降级到可能漏红线的桶）。
    fallback: null,
  });
}

// 纯函数：从分类器输出里抽 memory_type，非法/缺失返回 null。可单测。
export function parseMemoryType(raw: string): MemoryKind | null {
  const o = parseJsonish(raw);
  if (!o) return null;
  return parseMemoryTypeObj(o);
}
