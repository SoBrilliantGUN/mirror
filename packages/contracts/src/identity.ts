// —— 结构化身份字段（做梦时反思抽取，单值、覆盖）——
// 区别于 profile（软特质：性格/价值观/洞察）：身份是「对方是谁」的基本信息，
// 每个字段天然单值（中文名只有一个、性别只有男/女），所以用 field→value 覆盖式存储，
// 不做自由文本记忆、不查重。字段名动态——常见字段用规范标签，没覆盖的由反思自造。

export type IdentityField = {
  field: string;   // 规范字段名：'中文名' / '英文名' / '昵称' / '性别' / '职业' / '宠物' / ...
  value: string;   // 单值
};

export interface IdentityStore {
  list(personaName: string, userId: string): Promise<IdentityField[]>;
  upsert(personaName: string, userId: string, fields: IdentityField[]): Promise<void>;
}
