import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Memory, MemoryKind, MemoryStore, PeriodicRule, RecalledMemories, TimeAnchor } from '@mirror/contracts';
import type { Embedder } from '../llm/embedding';

// 长期记忆存储（Postgres + pgvector + pg_trgm）。五型记忆 + 混合召回，参考 kima 的
// CopilotMemory，但只保留核心子集：constraint 硬召回、fact entity 覆盖、
// episodic 30 天软衰减、dense+trgm 的 RRF 融合召回。不做软删除复活 / ACT-R 激活值那些重设施。
//
// 隔离维度：每条记忆同时挂 character_id（哪个陪伴者记得）+ user_id（哪位用户）。人物间画像
// 完全隔离——程书衡不会读到只告诉沈知遥的事。character_id 用 persona.name（PERSONAS 主键）。

const EPISODIC_TTL_DAYS = 30;
// profile 去重阈值：近重复人设/洞察的余弦相似度（1 - 向量距离）达到此值即视为重复，不重复入库。
// 实测近重复（措辞微变）≈0.99+，不同洞察 ≈0.63~0.72，取 0.9 留足裕量。
const PROFILE_DUP_SIM = 0.9;

// 激活值（遗忘公式，对齐 kima `services/copilot.py` 的 compute_activation）：
//   activation = exp(-age/ttl) + log(1+access_count)·ACCESS_LOG_FACTOR +（近 RECENCY_WINDOW 天内被召回 ? RECENCY_BONUS : 0）
// 只有 episodic 走它（其余型无 ttl、恒上场）；activation >= RECALL_FLOOR 才召回，否则视为「已遗忘」。
// 这是软激活：反复/近期被召回的情节记忆会续命，不再硬 TTL 一刀切到 30 天就死。
const RECALL_FLOOR = 0.05;
const ACCESS_LOG_FACTOR = 0.2;
const RECENCY_BONUS = 0.3;
const RECENCY_WINDOW_DAYS = 7;

export function computeActivation(m: Memory, now: Date): number {
  if (m.kind !== 'episodic') return 1;
  const ageDays = Math.max((now.getTime() - new Date(m.createdAt).getTime()) / 86_400_000, 0);
  const base = Math.exp(-ageDays / EPISODIC_TTL_DAYS);
  const frequency = Math.log(1 + Math.max(m.accessCount, 0)) * ACCESS_LOG_FACTOR;
  let recency = 0;
  if (m.lastAccess && (now.getTime() - new Date(m.lastAccess).getTime()) / 86_400_000 < RECENCY_WINDOW_DAYS) {
    recency = RECENCY_BONUS;
  }
  return Math.min(1, base + frequency + recency);
}

function aboveFloor(m: Memory, now: Date): boolean {
  return computeActivation(m, now) >= RECALL_FLOOR;
}

type MemoryRow = {
  id: string;
  user_id: string;
  character_id: string;
  kind: string;
  content: string;
  entity_id: string | null;
  dimension: string | null;
  aspect: string | null;
  anchor_kind: string | null;
  anchor_at: Date | string | null;
  anchor_rule: unknown;
  access_count: number;
  last_access: Date | string | null;
  superseded: boolean;
  version: number;
  created_at: Date | string;
};

// date 列（anchor_at）从 pg 读回是本地午夜 Date，不能用 toISOString（会按 UTC 偏移一天）。
function dateToYmd(d: Date | string): string {
  const x = d instanceof Date ? d : new Date(d);
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const dd = String(x.getDate()).padStart(2, '0');
  return `${x.getFullYear()}-${m}-${dd}`;
}

function rowToAnchor(r: MemoryRow): TimeAnchor | undefined {
  if (r.anchor_kind === 'absolute' && r.anchor_at) return { kind: 'absolute', at: dateToYmd(r.anchor_at) };
  if (r.anchor_kind === 'periodic' && r.anchor_rule) return { kind: 'periodic', rule: r.anchor_rule as PeriodicRule };
  return undefined;
}

function toMemory(r: MemoryRow): Memory {
  return {
    id: r.id,
    userId: r.user_id,
    personaName: r.character_id,
    kind: r.kind as MemoryKind,
    content: r.content,
    entityId: r.entity_id,
    dimension: r.dimension,
    aspect: r.aspect,
    anchor: rowToAnchor(r),
    accessCount: r.access_count,
    lastAccess: r.last_access ? new Date(r.last_access).toISOString() : null,
    superseded: r.superseded,
    version: r.version,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

// RRF（Reciprocal Rank Fusion）融合多路召回。rankedLists 每路按分数降序排列（第一项 = rank 0）。
// 返回按融合分降序的 { item, score } 列表；item 是各路传入的同一标识（这里是 memory id）。
export function rrfFuse<T>(
  rankedLists: { item: T; score: number }[][],
  k = 60,
): { item: T; score: number }[] {
  const scores = new Map<T, number>();
  for (const list of rankedLists) {
    list.forEach((entry, rank) => {
      scores.set(entry.item, (scores.get(entry.item) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()]
    .map(([item, score]) => ({ item, score }))
    .sort((a, b) => b.score - a.score);
}

export function createMemoryStore(
  pool: Pool,
  embedder: Embedder,
  opts: { recallTopK: number },
): MemoryStore {
  const { recallTopK } = opts;

  // 活跃过滤：只按 superseded。episodic 的时间衰减不在这里做硬 TTL 一刀切，改由
  // computeActivation 在召回后软过滤（对齐 kima 的软激活）。getCoverage 沿用此过滤，
  // 语义是「维度覆盖率 = 是否曾了解过」，不看情节新鲜度，故不额外按 floor 过滤。
  const ACTIVE = `NOT superseded`;

  const getById = async (id: string): Promise<Memory> => {
    const { rows } = await pool.query<MemoryRow>(`SELECT * FROM memories WHERE id = $1`, [id]);
    return toMemory(rows[0]);
  };

  // 语义检索（dense）：余弦相似度，返回 { id, score }（score = 1 - cosine distance）。
  const denseSearch = async (personaName: string, userId: string, kind: MemoryKind, qvec: number[], topK: number): Promise<{ id: string; score: number }[]> => {
    const { rows } = await pool.query<{ id: string; score: number }>(
      `SELECT id, 1 - (embedding <=> $3::vector) AS score
         FROM memories
        WHERE character_id = $1 AND user_id = $2 AND kind = $4 AND embedding IS NOT NULL AND ${ACTIVE}
        ORDER BY embedding <=> $3::vector
        LIMIT $5`,
      [personaName, userId, toVectorLiteral(qvec), kind, topK],
    );
    return rows;
  };

  // 词法检索（lexical）：pg_trgm word_similarity（中文按字符 trigram 工作）。
  const lexicalSearch = async (personaName: string, userId: string, kind: MemoryKind, query: string, topK: number): Promise<{ id: string; score: number }[]> => {
    const { rows } = await pool.query<{ id: string; score: number }>(
      `SELECT id, word_similarity($3, content) AS score
         FROM memories
        WHERE character_id = $1 AND user_id = $2 AND kind = $4 AND ${ACTIVE}
          AND word_similarity($3, content) > 0.1
        ORDER BY score DESC
        LIMIT $5`,
      [personaName, userId, query, kind, topK],
    );
    return rows;
  };

  const touch = async (ids: string[]): Promise<void> => {
    await pool.query(
      `UPDATE memories SET access_count = access_count + 1, last_access = now() WHERE id = ANY($1::uuid[])`,
      [ids],
    );
  };

  // 单型混合召回：dense + lexical RRF 融合后取 top-k，回写访问计数（检索强化）。
  const hybridRecall = async (personaName: string, userId: string, kind: MemoryKind, query: string, qvec: number[]): Promise<Memory[]> => {
    const [dense, lexical] = await Promise.all([
      denseSearch(personaName, userId, kind, qvec, recallTopK),
      lexicalSearch(personaName, userId, kind, query, recallTopK),
    ]);
    const fused = rrfFuse([
      dense.map((d) => ({ item: d.id, score: d.score })),
      lexical.map((l) => ({ item: l.id, score: l.score })),
    ]).slice(0, recallTopK);
    if (fused.length === 0) return [];
    const ids = fused.map((f) => f.item);
    await touch(ids);
    const { rows } = await pool.query<MemoryRow>(`SELECT * FROM memories WHERE id = ANY($1::uuid[])`, [ids]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const now = new Date();
    return fused
      .map((f) => byId.get(f.item))
      .filter((m): m is MemoryRow => Boolean(m))
      .map(toMemory)
      .filter((m) => aboveFloor(m, now));
  };

  const listActive = async (personaName: string, userId: string, kind: MemoryKind): Promise<Memory[]> => {
    const { rows } = await pool.query<MemoryRow>(
      `SELECT * FROM memories WHERE character_id = $1 AND user_id = $2 AND kind = $3 AND ${ACTIVE} ORDER BY created_at ASC`,
      [personaName, userId, kind],
    );
    const now = new Date();
    return rows.map(toMemory).filter((m) => aboveFloor(m, now));
  };

  // 带时间锚点的活跃记忆（时间感知 upcomingDates 用；数量小，周期评估在 TS 侧 timeAware）。
  const listAnchored = async (personaName: string, userId: string): Promise<Memory[]> => {
    const { rows } = await pool.query<MemoryRow>(
      `SELECT * FROM memories WHERE character_id = $1 AND user_id = $2 AND anchor_kind IS NOT NULL AND ${ACTIVE}`,
      [personaName, userId],
    );
    const now = new Date();
    return rows.map(toMemory).filter((m) => aboveFloor(m, now));
  };

  // 好奇心覆盖率：按 dimension + aspect 数活跃事实（fact/preference/episodic），缺口检测用。
  const getCoverage = async (personaName: string, userId: string): Promise<{ dimension: string; aspect: string | null; count: number }[]> => {
    const { rows } = await pool.query<{ dimension: string; aspect: string | null; count: number }>(
      `SELECT dimension, aspect, COUNT(*)::int AS count FROM memories
        WHERE character_id = $1 AND user_id = $2 AND kind IN ('fact','preference','episodic')
          AND dimension IS NOT NULL AND dimension <> '' AND ${ACTIVE}
        GROUP BY dimension, aspect`,
      [personaName, userId],
    );
    return rows;
  };

  // 撤销错误记忆：对方纠正了之前听错/记错的事实（如「全栈」被听成「签证」）。
  // 把含该关键词的活跃 fact/preference/episodic 归档（superseded，不硬删）。关键词太短（<2 字）跳过，防误删。
  const retract = async (personaName: string, userId: string, keyword: string): Promise<number> => {
    const kw = (keyword ?? '').trim();
    if (kw.length < 2) return 0;
    const { rowCount } = await pool.query(
      `UPDATE memories SET superseded = true, superseded_at = now()
        WHERE character_id = $1 AND user_id = $2 AND kind IN ('fact','preference','episodic')
          AND NOT superseded AND content LIKE '%' || $3 || '%'`,
      [personaName, userId, kw],
    );
    return rowCount ?? 0;
  };

  // 按 id 精确撤销（superseded）——纠正「上一轮刚写入」的记忆时用，不做关键词模糊匹配。
  const retractById = async (personaName: string, userId: string, id: string): Promise<number> => {
    if (!id) return 0;
    const { rowCount } = await pool.query(
      `UPDATE memories SET superseded = true, superseded_at = now()
        WHERE id = $1 AND character_id = $2 AND user_id = $3
          AND kind IN ('fact','preference','episodic') AND NOT superseded`,
      [id, personaName, userId],
    );
    return rowCount ?? 0;
  };

  // 上限裁剪：某型活跃记忆超过 keep 条时，把最旧的归档（superseded，不硬删，可审计）。返回归档条数。
  const prune = async (personaName: string, userId: string, kind: MemoryKind, keep: number): Promise<number> => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM memories WHERE character_id = $1 AND user_id = $2 AND kind = $3 AND ${ACTIVE} ORDER BY created_at ASC`,
      [personaName, userId, kind],
    );
    const excess = rows.slice(0, Math.max(0, rows.length - keep));
    if (excess.length === 0) return 0;
    await pool.query(
      `UPDATE memories SET superseded = true, superseded_at = now() WHERE id = ANY($1::uuid[])`,
      [excess.map((r) => r.id)],
    );
    return excess.length;
  };

  // profile 去重：反思可能反复生成同一条人设/洞察（内容精确相同，或措辞微变的语义重复）。
  // emb 为空时只按 content 精确查重；有 emb 时再按余弦相似度近义查重（复用 write 里已算好的向量）。
  // 命中返回已存在的活跃条，否则 null。
  const findDuplicateProfile = async (
    personaName: string,
    userId: string,
    content: string,
    emb: number[] | null,
  ): Promise<Memory | null> => {
    if (emb === null) {
      const { rows } = await pool.query<MemoryRow>(
        `SELECT * FROM memories
          WHERE character_id = $1 AND user_id = $2 AND kind = 'profile' AND content = $3 AND ${ACTIVE}
          LIMIT 1`,
        [personaName, userId, content],
      );
      return rows[0] ? toMemory(rows[0]) : null;
    }
    const { rows } = await pool.query<{ id: string; score: number }>(
      `SELECT id, 1 - (embedding <=> $3::vector) AS score
         FROM memories
        WHERE character_id = $1 AND user_id = $2 AND kind = 'profile' AND embedding IS NOT NULL AND ${ACTIVE}
        ORDER BY embedding <=> $3::vector
        LIMIT 1`,
      [personaName, userId, toVectorLiteral(emb)],
    );
    if (rows[0] && rows[0].score >= PROFILE_DUP_SIM) {
      return getById(rows[0].id);
    }
    return null;
  };

  // 笔记本/记忆库：跨型列出未归档记忆（可选 kind 过滤、since 起点），按创建时间倒序。
  // 不做 episodic 软激活过滤——管理面板要看到全部（含"软遗忘"的），让用户能手动清理。
  const listAll = async (
    personaName: string,
    userId: string,
    opts: { kind?: MemoryKind; since?: string } = {},
  ): Promise<Memory[]> => {
    const conds = [`character_id = $1`, `user_id = $2`, ACTIVE];
    const params: unknown[] = [personaName, userId];
    if (opts.kind) {
      params.push(opts.kind);
      conds.push(`kind = $${params.length}`);
    }
    if (opts.since) {
      params.push(opts.since);
      conds.push(`created_at >= $${params.length}`);
    }
    const { rows } = await pool.query<MemoryRow>(
      `SELECT * FROM memories WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(toMemory);
  };

  // 笔记本编辑：就地改 content / kind（同 id，不新建）。找不到（或不属于该用户/人物）返回 null。
  const updateMemory = async (
    personaName: string,
    userId: string,
    id: string,
    patch: { content?: string; kind?: MemoryKind },
  ): Promise<Memory | null> => {
    const sets: string[] = [];
    const params: unknown[] = [id, personaName, userId];
    if (patch.content !== undefined) {
      params.push(patch.content);
      sets.push(`content = $${params.length}`);
    }
    if (patch.kind !== undefined) {
      params.push(patch.kind);
      sets.push(`kind = $${params.length}`);
    }
    if (sets.length === 0) return getById(id);
    const { rows } = await pool.query<MemoryRow>(
      `UPDATE memories SET ${sets.join(', ')} WHERE id = $1 AND character_id = $2 AND user_id = $3 RETURNING *`,
      params,
    );
    return rows[0] ? toMemory(rows[0]) : null;
  };

  // 笔记本删除：软删除（superseded，可审计不硬删）。返回归档条数（0 = 不存在或已删）。
  const removeMemory = async (personaName: string, userId: string, id: string): Promise<number> => {
    const { rowCount } = await pool.query(
      `UPDATE memories SET superseded = true, superseded_at = now()
        WHERE id = $1 AND character_id = $2 AND user_id = $3 AND NOT superseded`,
      [id, personaName, userId],
    );
    return rowCount ?? 0;
  };

  return {
    async recall(personaName, userId, query): Promise<RecalledMemories> {
      const qvec = (await embedder.embed([query]))[0];
      const [constraint, profile, preference, fact, episodic] = await Promise.all([
        listActive(personaName, userId, 'constraint'),
        listActive(personaName, userId, 'profile'), // profile 强制在场：全量召回（不走向量，像 constraint）
        hybridRecall(personaName, userId, 'preference', query, qvec),
        hybridRecall(personaName, userId, 'fact', query, qvec),
        hybridRecall(personaName, userId, 'episodic', query, qvec),
      ]);
      return { constraint, profile, fact, preference, episodic };
    },

    async search(personaName, userId, query, kind, topK = recallTopK): Promise<Memory[]> {
      const qvec = (await embedder.embed([query]))[0];
      const kinds: MemoryKind[] = kind ? [kind] : ['fact', 'episodic'];
      const hits = (await Promise.all(kinds.map((k) => hybridRecall(personaName, userId, k, query, qvec)))).flat();
      return hits.slice(0, topK);
    },

    async write(personaName, userId, { kind, content, entityId = null, dimension = null, aspect = null, anchor = null }): Promise<Memory> {
      // profile 先精确查重：命中直接返回已存在条，省掉一次 embedding 调用。
      if (kind === 'profile') {
        const dup = await findDuplicateProfile(personaName, userId, content, null);
        if (dup) return dup;
      }
      const [emb] = await embedder.embed([content]);
      // profile 再近义查重：复用刚算好的向量，拦截「措辞微变但语义重复」的人设/洞察重复入库。
      if (kind === 'profile') {
        const dup = await findDuplicateProfile(personaName, userId, content, emb);
        if (dup) return dup;
      }
      const id = randomUUID();
      const ttlDays = kind === 'episodic' ? EPISODIC_TTL_DAYS : null;
      let version = 1;

      // fact 同 entity 覆盖：旧活跃条留痕 superseded，新条 version++（不硬删，可审计）。
      if (kind === 'fact' && entityId) {
        const { rows } = await pool.query<{ id: string; version: number }>(
          `SELECT id, version FROM memories
            WHERE character_id = $1 AND user_id = $2 AND kind = 'fact' AND entity_id = $3 AND ${ACTIVE}
            ORDER BY version DESC`,
          [personaName, userId, entityId],
        );
        for (const r of rows) {
          await pool.query(
            `UPDATE memories SET superseded = true, superseded_at = now(), superseded_by = $1 WHERE id = $2`,
            [id, r.id],
          );
        }
        version = (rows[0]?.version ?? 0) + 1;
      }

      const anchorKind = anchor?.kind ?? null;
      const anchorAt = anchor?.kind === 'absolute' ? anchor.at : null;
      const anchorRule = anchor?.kind === 'periodic' ? anchor.rule : null;
      await pool.query(
        `INSERT INTO memories (id, character_id, user_id, kind, content, entity_id, dimension, aspect, anchor_kind, anchor_at, anchor_rule, embedding, ttl_days, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::vector, $13, $14)`,
        [id, personaName, userId, kind, content, entityId, dimension, aspect, anchorKind, anchorAt, anchorRule ? JSON.stringify(anchorRule) : null, toVectorLiteral(emb), ttlDays, version],
      );
      return getById(id);
    },

    listActive,
    listAnchored,
    listAll,
    update: updateMemory,
    remove: removeMemory,
    getCoverage,
    retract,
    retractById,
    prune,
  };
}
