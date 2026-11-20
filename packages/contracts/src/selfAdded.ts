// —— 人设增补（陪伴者底座之外的软细节，永久固化 + 提及驱动衰减）——
// 数据：每条 = 陪伴者在对话中自然说出的、关于他自己的软细节（爱好/口味/小回忆/习惯）。
// 铁律：底座不可推翻（角色卡写死）、增量一经写出强制一致、只补软细节。
// 注意：本类型 SelfAdded 在 DB 里的表名是 persona_additions（见 store/db.ts）——表名沿用旧词「persona」，别跟记忆类型 profile（关于用户）混淆。
export type SelfAdded = {
  id: string;
  userId: string;
  personaName: string;
  category: string;      // 回忆 | 喜好 | 习惯 | 口味 | 其它
  content: string;       // 一句话，小而具体："高中在篮球队打过替补"
  mentionCount: number;  // 提及次数（对话中再次被触碰则 +1）
  lastMentionedAt: string | null; // 最近一次被提及（ISO）；null = 从未
  active: boolean;       // 软衰减归档：false = 不再注入（可回溯）
  createdAt: string;
};

// 人设增补存储：独立于用户长期记忆（那是「关于用户」，这是「关于陪伴者自己」）。
export interface SelfAddedStore {
  listActive(personaName: string, userId: string): Promise<SelfAdded[]>;
  write(personaName: string, userId: string, input: { category: string; content: string }): Promise<SelfAdded>;
  touch(personaName: string, userId: string, ids: string[]): Promise<void>;
  archiveStale(personaName: string, userId: string, ttlDays: number): Promise<number>;
}
