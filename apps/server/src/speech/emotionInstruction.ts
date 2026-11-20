import type { EmotionTag } from '@mirror/contracts';

// 通用镜像层（16 位陪伴者共用）：对方情绪 → 回应方向指令。
// 写细了：不只语气方向，还带「换气/呼吸」「句尾处理」「节奏」提示，
// 让 CosyVoice 尽量有抑扬顿挫，而不是匀速念稿。
export const EMOTION_DIRECTION: Record<EmotionTag, string> = {
  warm: '用温暖轻快、带着笑意的语气说；句与句之间轻轻换气，别连成一片；句尾轻轻上扬，像在等对方接话；重音落在关键词上，不要匀速念稿。',
  tender: '用温柔轻柔、心疼共情的语气说；句间留出呼吸的空档；尾音轻轻落下、带一点气声，像怕惊到对方；不要一字一顿、不要读稿腔。',
  steady: '用沉稳镇定、给人确定感的语气说；每个短句稳稳落地，句尾平缓下压、不飘不赶；换气自然、停顿稍长；避免上扬的疑问腔。',
  natural: '用轻松自然、口语化的语气，像面对面聊天；节奏随内容自然起伏，该快就快、该顿就顿；句尾该上扬就上扬、该落下就落下，别机器般匀速。',
};

// 方向之外的 prosody 微调（语速/音调），帮助拉开相邻方向。
// 注意：rate < 1.0（放慢）会导致「发音被拉长」，听感像慢放、不自然，所以 tender/steady 不再用 rate 放慢，
// 情绪差异只靠 instruction 的语气词 + 停顿来带，不靠机械拉长。
export const EMOTION_PROSODY: Record<EmotionTag, { rate?: number; pitch?: number }> = {
  warm:   { rate: 1.05, pitch: 1.05 }, // 更轻快、更明亮
  tender: {},                          // 温柔靠 instruction，不靠放慢
  steady: {},                          // 沉稳靠 instruction，不靠放慢
  natural: {},                         // 不调
};

// 人设底色层（每位陪伴者不同，来自角色卡 voiceTint）。
export function buildInstruction(emotion: EmotionTag, voiceTint?: string): string {
  return voiceTint ? `${EMOTION_DIRECTION[emotion]}，${voiceTint}` : EMOTION_DIRECTION[emotion];
}

// 按句末标点追加句尾处理（逐句差异化，配合 base 指令用）。
export function tailHint(text: string): string {
  const last = text.trim().slice(-1);
  if (last === '？' || last === '?') return '。这是问句，句尾要轻轻上扬，像真的在等对方回答。';
  if (last === '！' || last === '!') return '。这句语气要加重，句尾稳而有力。';
  return '。这句句尾自然落下，不要上扬。';
}
