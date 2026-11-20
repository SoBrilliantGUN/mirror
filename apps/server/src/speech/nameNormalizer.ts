import { pinyin } from 'pinyin-pro';

// 名字同音字纠正：ASR 常把陪伴者的名字/昵称听成同音字（如「明悦」→「明月」），
// 导致模型看到错误写法后反而去纠正对方。这里在文本进模型前，按「当前人物」把其名字的
// 已知同音字写法确定性改回正确写法。只碰名字这一小类，不碰正文里其它同音词。
//
// key = 人物全名（persona.name），value = { 听错写法 → 正确写法 }。
// 只列「名」（去掉姓氏的昵称，如「明悦」）的常见同音字即可——全名（「苏明悦」）若只有
// 名被听错，会因子串匹配自动纠正成「苏明悦」。姓氏同音字暂不覆盖。
// 注意：个别变体本身也是常用词（如「明月」= 月亮），但因仅在「和该人物通话」时生效，
// 且对话语境下几乎不会单独聊到那个词，误伤概率很低；如后续踩到可再加语境判断。
const NAME_VARIANTS: Record<string, Record<string, string>> = {
  '顾承安': { '成安': '承安', '程安': '承安' },
  '苏念安': { '年安': '念安' },
  '沈砚秋': { '燕秋': '砚秋', '雁秋': '砚秋' },
  '顾言欢': { '颜欢': '言欢', '妍欢': '言欢' },
  '江亦驰': { '易驰': '亦驰', '一驰': '亦驰' },
  '温以柔': { '依柔': '以柔', '伊柔': '以柔' },
  '林默笙': { '墨笙': '默笙' },
  '沈知遥': { '之遥': '知遥', '知谣': '知遥' },
  '秦烈阳': { '列阳': '烈阳' },
  '苏明悦': { '明月': '明悦' },
  '陆星辰': { '星晨': '星辰', '新辰': '星辰' },
  '韩知微': { '之微': '知微', '知薇': '知微' },
  '程书衡': { '书恒': '书衡' },
  '何以安': { '依安': '以安', '伊安': '以安' },
  '顾知秋': { '之秋': '知秋' },
  '秦穆清': { '木清': '穆清', '慕清': '穆清' },
};

export function normalizePersonaName(text: string, personaName: string): string {
  const variants = NAME_VARIANTS[personaName];
  if (!variants || !text) return text;
  let out = text;
  for (const [wrong, right] of Object.entries(variants)) {
    out = out.split(wrong).join(right);
  }
  return out;
}

// 用户名同音字纠正（拼音指纹）：把用户名的拼音当"指纹"，扫描文本里拼音一致（忽略声调）的
// 连续子串，替换成正确名字。解决语音识别把用户名听成同音字（张渔歌 → 章鱼哥）的问题。
// 只匹配「全名」，不匹配去掉姓氏的"名"，降低把真实词（如"章鱼"）误替换的概率。
export function normalizeUserName(text: string, userName: string): string {
  const name = (userName ?? '').trim();
  if (!name || !text) return text;
  const nameChars = [...name];
  const textChars = [...text];
  if (textChars.length < nameChars.length) return text;

  const namePinyin = nameChars.map((c) => pinyin(c, { toneType: 'none' }).trim());
  const textPinyin = textChars.map((c) => pinyin(c, { toneType: 'none' }).trim());

  let out = '';
  let i = 0;
  while (i < textChars.length) {
    if (i + nameChars.length <= textChars.length) {
      let matched = true;
      for (let j = 0; j < nameChars.length; j++) {
        if (textPinyin[i + j] !== namePinyin[j]) { matched = false; break; }
      }
      if (matched) {
        out += name;
        i += nameChars.length;
        continue;
      }
    }
    out += textChars[i];
    i++;
  }
  return out;
}
