import type { TimeAnchor } from './time';
import type { PersonaName } from './persona';

// 字段语义提醒：本文件里所有 `personaName` 存的都是 `PersonaName`（陪伴者的中文名，如 "程书衡"），
// 不是数字/UUID ID。它同时是「人物隔离」的维度——程书衡不会读到只告诉沈知遥的事。

// —— 长期记忆（五型，参考 kima 的 CopilotMemory 分类；embedding + pgvector 混合召回）——
// constraint = 硬规则/红线（无条件在场）；fact = 稳定事实（entity_id 覆盖）；
// preference = 偏好/软规则；episodic = 带时间锚点的事件（默认 30 天衰减）；
// profile = 特质（对方的稳定性格/价值观/长期模式 + 对对方的高层洞察，强制在场，单独成型）。
// 注：与陪伴者实体 `Persona`（角色）无关——这是「关于用户」的记忆类型。
export type MemoryKind = 'constraint' | 'fact' | 'preference' | 'episodic' | 'profile';

export type Memory = {
  id: string;
  userId: string;
  personaName: PersonaName;
  kind: MemoryKind;
  content: string;
  entityId: string | null;
  dimension: string | null; // 好奇心维度（原生家庭/职业/…）；constraint/persona 为 null
  aspect: string | null;    // 维度下的子槽（如原生家庭→母亲）；没有则为 null
  anchor?: TimeAnchor;      // 时间锚点（绝对/周期）；无时间含义的记忆为 undefined
  accessCount: number;
  lastAccess: string | null;
  superseded: boolean;
  version: number;
  createdAt: string;
};

// 好奇心覆盖率的一行：某维度下某子槽的已知事实数（aspect 为 null = 只归了维度、没归子槽）。
export type CoverageEntry = { dimension: string; aspect: string | null; count: number };

// 分路召回结果：constraint + profile 硬召回全量（强制在场）；其余三型走混合召回（按相似度过滤）。
export type RecalledMemories = {
  constraint: Memory[];
  profile: Memory[];
  fact: Memory[];
  preference: Memory[];
  episodic: Memory[];
};

export interface MemoryStore {
  // 每个方法的第一个参数 personaName = 当前陪伴者（persona.name），按人物隔离用户画像：
  // 程书衡不会读到只告诉沈知遥的事。见 store/memory.ts。
  // 混合召回：constraint 全量 + fact/preference/episodic 语义检索（供每轮 [MEMORY] 块注入）。
  recall(personaName: string, userId: string, query: string): Promise<RecalledMemories>;
  // 语义检索（recall_memory 工具按需读）。
  search(personaName: string, userId: string, query: string, kind?: MemoryKind, topK?: number): Promise<Memory[]>;
  // 写入一条记忆（fact 同 entity_id 覆盖旧条、旧条留痕 superseded）；anchor 为可选时间锚点。
  write(personaName: string, userId: string, input: { kind: MemoryKind; content: string; entityId?: string | null; dimension?: string | null; aspect?: string | null; anchor?: TimeAnchor | null }): Promise<Memory>;
  // 好奇心覆盖率：按 dimension + aspect 数活跃事实（缺口检测用）。
  getCoverage(personaName: string, userId: string): Promise<CoverageEntry[]>;
  // 全量列出某型活跃记忆（只读面板 / 调试用）。
  listActive(personaName: string, userId: string, kind: MemoryKind): Promise<Memory[]>;
  // 全量列出带时间锚点的活跃记忆（时间感知 upcomingDates 用；数量小，周期评估放 TS 侧）。
  listAnchored(personaName: string, userId: string): Promise<Memory[]>;
  // 笔记本/记忆库：跨型列出未归档记忆（可选按 kind 过滤、按 created_at 起点的 since 过滤），按创建时间倒序。
  // 注意：不做 episodic 软激活过滤——管理面板要看到全部（含"软遗忘"的）。
  listAll(personaName: string, userId: string, opts?: { kind?: MemoryKind; since?: string }): Promise<Memory[]>;
  // 笔记本编辑：就地改 content / kind（同 id，不新建、不换行）。找不到返回 null。
  update(personaName: string, userId: string, id: string, patch: { content?: string; kind?: MemoryKind }): Promise<Memory | null>;
  // 笔记本删除：软删除（superseded，可审计不硬删）。返回归档条数（0 = 不存在或已删）。
  remove(personaName: string, userId: string, id: string): Promise<number>;
  // 撤销错误记忆：对方纠正了之前听错/记错的事实，把含关键词的活跃 fact/preference/episodic 归档（superseded）。返回归档条数。
  retract(personaName: string, userId: string, keyword: string): Promise<number>;
  // 按 id 精确撤销一条活跃记忆（superseded）——纠正「上一轮刚写入」的记忆时用，不做关键词模糊匹配。返回归档条数。
  retractById(personaName: string, userId: string, id: string): Promise<number>;
  // 上限裁剪：某型活跃记忆超过 keep 条时，把最旧的归档（superseded，不硬删）。返回归档条数。
  prune(personaName: string, userId: string, kind: MemoryKind, keep: number): Promise<number>;
}
