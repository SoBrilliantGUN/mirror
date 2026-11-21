import type { Pool } from 'pg';

// 已问过的好奇心话题 id（去重）：表结构见 db.ts ensureSchema 的 asked_topics。
export function createAskedTopicsStore(pool: Pool) {
  return {
    // 记录已问过的话题 id（幂等，重复问不重复记）。
    async record(personaName: string, userId: string, questionId: string): Promise<void> {
      await pool.query(
        `INSERT INTO asked_topics (persona_name, user_id, question_id) VALUES ($1, $2, $3)
         ON CONFLICT (persona_name, user_id, question_id) DO NOTHING`,
        [personaName, userId, questionId],
      );
    },

    // 已问过的 id 集合。
    async listAsked(personaName: string, userId: string): Promise<Set<string>> {
      const { rows } = await pool.query(
        `SELECT question_id FROM asked_topics WHERE persona_name = $1 AND user_id = $2`,
        [personaName, userId],
      );
      return new Set(rows.map((r) => r.question_id as string));
    },
  };
}

export type AskedTopicsStore = ReturnType<typeof createAskedTopicsStore>;
