import type { Pool } from 'pg';
import type { GrowthGoal, GrowthGoalStore, GrowthStage } from '@mirror/contracts';

// 成长课题存储（Life Coach 的「重骨架」）：GROW 四段 + 生命周期，跨通话持久。
// 按 character_id + user_id 隔离（与记忆同口径）；status：active / done / archived。
// 「轻的表达」不在这里——这里只存结构化进度，话术化由 [GOAL] 块 + 模型完成。

type GoalRow = {
  id: string;
  user_id: string;
  character_id: string;
  title: string;
  goal: string | null;
  reality: string | null;
  options: string | null;
  will: string | null;
  stage: string;
  progress_note: string | null;
  status: string;
  last_reviewed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

// 注意：这里的 STAGES 含 'done'，因为落库后的 GrowthGoal.stage 可能是 done（由 complete() 写入）；
// 与 consolidate/goalTurn.ts 里那份「只校验 LLM 输出 G/R/O/W」的 STAGES 用途不同，别混。
const STAGES = new Set<GrowthStage>(['goal', 'reality', 'options', 'will', 'done']);

function toGoal(r: GoalRow): GrowthGoal {
  return {
    id: r.id,
    userId: r.user_id,
    personaName: r.character_id,
    title: r.title,
    goal: r.goal,
    reality: r.reality,
    options: r.options,
    will: r.will,
    stage: (STAGES.has(r.stage as GrowthStage) ? r.stage : 'goal') as GrowthStage,
    progressNote: r.progress_note,
    status: (r.status === 'done' || r.status === 'archived' ? r.status : 'active') as GrowthGoal['status'],
    lastReviewedAt: r.last_reviewed_at ? new Date(r.last_reviewed_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export function createGoalsStore(pool: Pool): GrowthGoalStore {
  const getById = async (id: string): Promise<GrowthGoal | null> => {
    const { rows } = await pool.query<GoalRow>(`SELECT * FROM growth_goals WHERE id = $1`, [id]);
    return rows[0] ? toGoal(rows[0]) : null;
  };

  return {
    async listActive(personaName, userId): Promise<GrowthGoal[]> {
      const { rows } = await pool.query<GoalRow>(
        `SELECT * FROM growth_goals
          WHERE character_id = $1 AND user_id = $2 AND status = 'active'
          ORDER BY updated_at ASC`,
        [personaName, userId],
      );
      return rows.map(toGoal);
    },

    async create(personaName, userId, input): Promise<GrowthGoal> {
      // 同名活跃课题复用（标题去重），避免后台巩固反复建「和妈妈的边界」这种重复条目。
      const { rows: dup } = await pool.query<GoalRow>(
        `SELECT * FROM growth_goals
          WHERE character_id = $1 AND user_id = $2 AND title = $3 AND status = 'active'
          ORDER BY created_at ASC LIMIT 1`,
        [personaName, userId, input.title],
      );
      if (dup[0]) return toGoal(dup[0]);

      const { rows } = await pool.query<GoalRow>(
        `INSERT INTO growth_goals (character_id, user_id, title)
         VALUES ($1, $2, $3) RETURNING *`,
        [personaName, userId, input.title],
      );
      return toGoal(rows[0]);
    },

    async update(personaName, userId, id, patch): Promise<GrowthGoal | null> {
      // 只更新传入的字段；updated_at 跟着走。用 EXISTS 兜底「这条不在这位用户/人物名下」。
      const fields: string[] = [];
      const vals: unknown[] = [];
      let i = 1;
      const set = (col: string, v: unknown) => {
        fields.push(`${col} = $${i++}`);
        vals.push(v);
      };
      if (patch.title !== undefined) set('title', patch.title);
      if (patch.goal !== undefined) set('goal', patch.goal);
      if (patch.reality !== undefined) set('reality', patch.reality);
      if (patch.options !== undefined) set('options', patch.options);
      if (patch.will !== undefined) set('will', patch.will);
      if (patch.stage !== undefined) set('stage', patch.stage);
      if (patch.progressNote !== undefined) set('progress_note', patch.progressNote);
      if (fields.length === 0) return getById(id);
      fields.push(`updated_at = now()`);
      vals.push(id, personaName, userId);
      const { rows } = await pool.query<GoalRow>(
        `UPDATE growth_goals SET ${fields.join(', ')}
          WHERE id = $${i} AND character_id = $${i + 1} AND user_id = $${i + 2} RETURNING *`,
        vals,
      );
      return rows[0] ? toGoal(rows[0]) : null;
    },

    async complete(personaName, userId, id, note = null): Promise<void> {
      await pool.query(
        `UPDATE growth_goals SET status = 'done', stage = 'done',
           progress_note = COALESCE($4, progress_note), updated_at = now()
          WHERE id = $1 AND character_id = $2 AND user_id = $3`,
        [id, personaName, userId, note],
      );
    },

    async archive(personaName, userId, id): Promise<void> {
      await pool.query(
        `UPDATE growth_goals SET status = 'archived', updated_at = now()
          WHERE id = $1 AND character_id = $2 AND user_id = $3`,
        [id, personaName, userId],
      );
    },

    async touch(personaName, userId, id): Promise<void> {
      await pool.query(
        `UPDATE growth_goals SET last_reviewed_at = now(), updated_at = now()
          WHERE id = $1 AND character_id = $2 AND user_id = $3`,
        [id, personaName, userId],
      );
    },
  };
}
