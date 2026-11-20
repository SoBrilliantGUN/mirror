// —— 交互框架（与 Mode 正交）：friend = 陪伴/映照，coach = GROW 成长引导。 ——
export type Frame = 'friend' | 'coach';

// 教练意图检测（每轮 LLM 判定，仿 farewell）：两个触发 + 一个退出 + 可选课题主题。
export type CoachCue = {
  explicit: boolean;      // 用户明说求助/要指引（"我该怎么办""我到底想要什么""好迷茫"）→ 立即进教练
  invite: boolean;        // 这轮有反复的成长卡点信号（反复说累/纠结/走不出来）→ 累计后温柔邀入
  resolved: boolean;      // 这轮明确表示课题做成了/解决了/放下了 → 教练态退出回朋友（收口）
  theme: string | null;   // 若可辨，本轮卡在什么事上的短词组（供邀入/命名课题）；看不出为 null
};

// —— 成长课题（Life Coach 的「重骨架」）：GROW 四段 + 生命周期，跨通话持久。
// 轻的表达 = 只在 [GOAL] 块把进度喂给模型，模型用自己的语气化进对话，绝不念档案。 ——

export type GrowthStage = 'goal' | 'reality' | 'options' | 'will' | 'done';

export type GrowthGoal = {
  id: string;
  userId: string;
  personaName: string;
  title: string;            // 课题名（如「和妈妈的边界」）
  goal: string | null;      // G：她想要的未来
  reality: string | null;   // R：现状/障碍
  options: string | null;   // O：可选路径（模型自然组织）
  will: string | null;      // W：最小下一步 + 时间（承诺）
  stage: GrowthStage;       // GROW 当前推进到哪一步
  progressNote: string | null; // 最近一次回顾的进展（轻表达素材）
  status: 'active' | 'done' | 'archived';
  lastReviewedAt: string | null; // 上次被回顾/追问的时间（问责节奏）；null = 从未
  createdAt: string;
  updatedAt: string;
};

export interface GrowthGoalStore {
  // 列出进行中的课题（status = active），供 [GOAL] 块注入；按 updated_at 升序。
  listActive(personaName: string, userId: string): Promise<GrowthGoal[]>;
  // 新建一条课题（重复 title 时复用已有活跃条）。返回最终那条。
  create(personaName: string, userId: string, input: { title: string; theme?: string | null }): Promise<GrowthGoal>;
  // 就地更新一条课题的 GROW 字段 + stage；按 title 匹配（后台巩固用）。
  update(personaName: string, userId: string, id: string, patch: {
    title?: string; goal?: string | null; reality?: string | null; options?: string | null;
    will?: string | null; stage?: GrowthStage; progressNote?: string | null;
  }): Promise<GrowthGoal | null>;
  // 课题做成 → status=done（庆祝后用）；note 可写一句收尾进展。
  complete(personaName: string, userId: string, id: string, note?: string | null): Promise<void>;
  // 放下/不再做 → status=archived（可回溯，不硬删）。
  archive(personaName: string, userId: string, id: string): Promise<void>;
  // 刷新「上次回顾时间」（本轮又聊到它了）。
  touch(personaName: string, userId: string, id: string): Promise<void>;
}
