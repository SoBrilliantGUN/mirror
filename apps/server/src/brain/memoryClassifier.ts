import type { MemoryKind } from '@mirror/contracts';
import type { DeepSeek } from '../llm/deepseek';
import { parseJsonish } from './parse';

// 记忆分类器：写入时用 LLM（temperature=0）确定性分类，替代「信任 Agent 自报 kind」。
// 参考 kima 的 memory_classifier.py——四型（约束/事实/偏好/情节）不能靠 Agent 随手挑，
// 否则一条红线被当事实写进去、走向量 top-k 就被相似度阈值漏掉。失败回退 null（信任自报）。

const CLASSIFY_SYSTEM_PROMPT = `你是记忆分类助手。把传入的记忆文本分类为五种类型之一，只输出 JSON，不要解释。

类型：
1. constraint —— 硬规则、禁令、红线（禁止/严禁/不得/必须/永远不要/不能）。示例：「不要在深夜问对方为什么哭」。
2. fact —— 关于用户的可变事实/当前状态（在/正在/目前/现在）。示例：「对方在准备考研」「对方目前没有工作」。
3. preference —— 软性偏好、习惯、风格（喜欢/习惯/希望/更愿意）。示例：「对方更喜欢听具体建议而不是大道理」。
4. episodic —— 带时间锚点的具体事件（昨天/上周/上次/那次/某次）。示例：「上周对方面试挂了两轮，很难过」。
5. profile —— 人设，只记「身份基本信息」和「长期稳定特质」两类：名字/性别/年龄/职业/学校/地域/重要关系（示例：「对方是深圳大学学生，广东人」「对方自称章鱼哥」），以及性格/价值观/长期模式这类长期稳定的东西。区别于 fact：fact 是可变状态，profile 是长期稳定的身份与特质。

只输出这个 JSON：
{"memory_type": "constraint" | "fact" | "preference" | "episodic" | "profile"}`;

export async function classifyMemory(
  llm: DeepSeek,
  model: string,
  raw: string,
): Promise<MemoryKind | null> {
  try {
    const out = await llm.chat(
      [
        { role: 'system', content: CLASSIFY_SYSTEM_PROMPT },
        { role: 'user', content: raw },
      ],
      { model, temperature: 0, maxTokens: 100 },
    );
    const type = parseMemoryType(out);
    return type;
  } catch {
    // LLM 分类失败 → 回退 null（信任 Agent 自报 kind，不静默降级到可能漏红线的桶）。
    return null;
  }
}

// 纯函数：从分类器输出里抽 memory_type，非法/缺失返回 null。可单测。
export function parseMemoryType(raw: string): MemoryKind | null {
  const o = parseJsonish(raw);
  if (!o) return null;
  const type = o.memory_type;
  if (type === 'constraint' || type === 'fact' || type === 'preference' || type === 'episodic' || type === 'profile') {
    return type;
  }
  return null;
}
