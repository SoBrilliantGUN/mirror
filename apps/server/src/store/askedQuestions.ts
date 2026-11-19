import type { Pool } from 'pg';

// 近 3 天已问过的问题（防重复提问）：每次陪伴者以问句结尾，就把这句问句记一条。
// 按 character/user 隔离，提问前拉最近 3 天的问题注入 [ASKED]，让模型别重复问。
export function createAskedQuestionsStore(pool: Pool) {
  return {
    async record(characterId: string, userId: string, question: string): Promise<void> {
      const q = (question ?? '').trim();
      if (q.length < 2) return;
      try {
        await pool.query(
          `INSERT INTO asked_questions (user_id, character_id, question) VALUES ($1, $2, $3)`,
          [userId, characterId, q],
        );
      } catch {
        /* best-effort，失败不阻断 */
      }
    },
    async recent(characterId: string, userId: string, days = 3): Promise<string[]> {
      try {
        const { rows } = await pool.query<{ question: string }>(
          `SELECT question FROM asked_questions
            WHERE character_id = $1 AND user_id = $2 AND asked_at >= now() - ($3 || ' days')::interval
            ORDER BY asked_at DESC LIMIT 20`,
          [characterId, userId, days],
        );
        return rows.map((r) => r.question);
      } catch {
        return [];
      }
    },
  };
}
