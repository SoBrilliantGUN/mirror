import type { DeepSeek } from '../llm/deepseek';
import { parseJsonish } from './parse';

// 道别检测：用 LLM 判定「对方这一轮是否在道别/要结束通话」，替代原来的关键词正则。
// 正则只看陪伴者自己的回复、漏判用户的再见；这里改用模型直接判用户意图，temperature 0 确定性输出。

const FAREWELL_SYSTEM_PROMPT = `你是道别意图判定器。读「对方这一轮的话」，判断对方是否在道别、想结束通话。只输出 JSON，不聊天、不解释。

判定为 true（道别）的情况：对方说再见、拜拜、晚安、改天再聊、下次聊、先挂了、不聊了、我要忙了/有事了、先这样、就到这吧，等表达「要结束这次通话」意图的话。
判定为 false 的情况：普通闲聊、顺着话题继续聊、问问题、分享事情；即使语气平淡或说「嗯」「好」「知道了」也不算道别。

宁缺毋滥：只有明显要结束通话的才判 true；含糊的「先这样吧」可以判 true，但单纯回应性的「好」「行」不判。

只输出这个 JSON，不要别的（不要 markdown 代码块、不要解释）：
{"farewell": true | false}`;

// 纯函数：从模型输出里抽 farewell 布尔，非法/缺失返回 false。可单测。
export function parseFarewell(raw: string): boolean {
  const o = parseJsonish(raw);
  if (!o) return false;
  const v = o.farewell;
  return v === true || v === 'true';
}

export async function classifyFarewell(llm: DeepSeek, model: string, text: string): Promise<boolean> {
  if (!text.trim()) return false; // 纯哭/纯笑无字，谈不上道别
  try {
    const out = await llm.chat(
      [
        { role: 'system', content: FAREWELL_SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      { model, temperature: 0, maxTokens: 50 },
    );
    return parseFarewell(out);
  } catch {
    // 分类失败 → 保守判 false（宁可多聊一句，也别误挂断）。
    return false;
  }
}
