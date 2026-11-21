import type { LlmClient } from '../llm/client';

// ASR 上下文纠错：语音识别把一句话听成同音/近音字（"刚跟八股文较劲完" → "干根巴股文较劲丸"）。
// 用最近对话上下文把明显听错的字词改回通顺原话，再进装配/落库。只改错字、不添意思。
// 与 nameNormalizer 的名字级纠正互补——那个只碰「名字」，这个碰「正文里的同音错字」。

const ASR_CORRECT_SYSTEM = `你是语音转写纠错器。对方刚说的一句话被语音识别听成了一串同音/近音字，可能有错别字、多字漏字、错词。请根据上下文，把它改写成对方真正想说的、通顺自然的中文。

规则：
1. 改「听错的字词」：同音/近音替换（如"较劲丸"→"较劲完"、"叫进来"→"较劲呢"、"超汕"→"潮汕"、"八谷/巴股/包谷"→"八股"）、把零碎音节拼回有意义的词。别因为错字"读得通"就放过——地名、专名、上下文中出现过的词尤其要改对。
2. 上下文有线索就对齐上下文：前面聊到"八股文""较劲""潮汕"，就别让这些词以错字出现。
3. 只纠正听错的字词，不增删对方没说过的意思，不把一句话改写成另一句话。
4. 只输出纠正后的那一句，不要解释、不要引号、不要任何前缀后缀。`;

export async function correctAsrText(
  llm: LlmClient,
  model: string,
  text: string,
  context: string,
): Promise<string> {
  const t = (text ?? '').trim();
  if (!t) return t;
  const user = context
    ? `【最近对话】\n${context}\n\n【对方刚说的话（可能听错）】\n${t}`
    : `【对方刚说的话（可能听错）】\n${t}`;
  try {
    const out = await llm.chat(
      [
        { role: 'system', content: ASR_CORRECT_SYSTEM },
        { role: 'user', content: user },
      ],
      { model, temperature: 0, maxTokens: 100 },
    );
    const corrected = (out ?? '').trim();
    return corrected || t; // 空回退原文
  } catch {
    return t; // 纠错失败不阻断，用原文继续
  }
}
