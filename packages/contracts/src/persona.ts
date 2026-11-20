// —— 角色卡（L6）——
// 人物标识：用「中文名」（如 "程书衡"）当主键，不是数字 ID。
// 全库凡叫 personaName 的字段，存的都是这个 PersonaName（见 memory.ts 顶部注释）。
export type PersonaName = string;

export type Persona = {
  name: PersonaName;
  mbti: string;          // 内部用，绝不对用户展示
  gender: '男' | '女';
  voiceId: string;       // 音色：区分「加载的是谁」
  voiceTint: string;     // 人设底色：这个陪伴者表达情绪时的语气修饰（来自角色卡）
  available: boolean;    // 是否已上线（未上线者前端置灰 + 服务端 resolvePersona 拒绝）
  rate?: number;         // 语速基线（1.0=正常），人设差异：强势型 ESTJ 可 1.1~1.15，温柔型可 <1.0
  systemPrompt: string;  // 角色卡底座（generate 的 ⑥人物块）
};
