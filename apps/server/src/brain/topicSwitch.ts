// 不感兴趣检测：唤醒低 + 回复慢 二者「且」才算，单独低唤醒只是「平静放松」。
// 纯函数，无副作用，可单测。

export const AROUSAL_LOW = 0;        // arousal < 0 = 唤醒偏低（平静/低能量一侧）
export const REPLY_SLOW_MS = 3000;   // 回复延迟 > 3s = 慢（陪伴者说完 → 用户开口）
export const DISINTEREST_LIMIT = 3;  // 连续 3 轮命中才换话题

// 返回新一轮的 streak + 本轮是否触发换话题。
export function evaluateDisinterest(
  arousal: number,
  latencyMs: number,
  prevStreak: number,
): { streak: number; switchTopic: boolean } {
  const hit = arousal < AROUSAL_LOW && latencyMs > REPLY_SLOW_MS;
  if (!hit) return { streak: 0, switchTopic: false };
  const streak = prevStreak + 1;
  return { streak, switchTopic: streak >= DISINTEREST_LIMIT };
}

// 敷衍检测：回复极短 + 内容空泛（全是语气词/应答词/敷衍虚词，没任何实质信息）。
// 与 evaluateDisinterest（唤醒低 + 回复慢）互补——敷衍常常又快又短，低唤醒信号抓不到它。
// 纯函数，无副作用，可单测。
export const PERFUNCTORY_LIMIT = 2; // 连续 2 轮敷衍 → 换话题
const PERFUNCTORY_MAX_LEN = 6;      // 超过 6 字基本有实质内容，不算敷衍

// 低信息量字符集：语气词 + 应答词 + 敷衍惯用虚词。整句都由这些字组成 = 没在认真回。
// 「我」放进来是因为"我不知道/我没事/我的"这类也是敷衍，但"我是医生"因"医生"不在此列不会被误判。
const PERFUNCTORY_CHARS = new Set(
  '嗯哦噢啊呃哈呵哎呀哟唉喂欸嗨嘿嘞咯嘛呢吗啦吧呗咧呐好的对是没行可有随便都还知道事就这样再说无所谓不想法记得别问提我'.split(''),
);

export function evaluatePerfunctory(
  text: string,
  prevStreak: number,
): { streak: number; switchTopic: boolean } {
  const t = (text ?? '').replace(/[。！？!?，,；;、\s~～…]/g, '').trim();
  if (!t) return { streak: 0, switchTopic: false }; // 空文本（纯哭/笑）不算敷衍
  const isPerfunctory = t.length <= PERFUNCTORY_MAX_LEN && [...t].every((c) => PERFUNCTORY_CHARS.has(c));
  if (!isPerfunctory) return { streak: 0, switchTopic: false };
  const streak = prevStreak + 1;
  return { streak, switchTopic: streak >= PERFUNCTORY_LIMIT };
}
