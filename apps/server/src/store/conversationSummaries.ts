import type { Pool } from 'pg';

// 最近对话概要（跨通话）：每次通话结束记一条「这次聊了哪些话题」的概要，
// 下次通话前拉最近 3 天的概要注入 [RECENT]，让陪伴者对最近聊过什么有印象。
// 与长期语义记忆互补：那个记「稳定事实/偏好/情节/人设」，这个记「最近聊了啥」。按 character/user 隔离。
export function createConversationSummariesStore(pool: Pool) {
  return {
    async save(characterId: string, userId: string, summary: string): Promise<void> {
      const s = (summary ?? '').trim();
      if (s.length < 2) return;
      try {
        await pool.query(
          `INSERT INTO conversation_summaries (user_id, character_id, summary) VALUES ($1, $2, $3)`,
          [userId, characterId, s],
        );
      } catch {
        /* best-effort，失败不阻断 */
      }
    },
    async recent(characterId: string, userId: string, days = 3): Promise<string[]> {
      try {
        const { rows } = await pool.query<{ summary: string }>(
          `SELECT summary FROM conversation_summaries
            WHERE character_id = $1 AND user_id = $2 AND created_at >= now() - ($3 || ' days')::interval
            ORDER BY created_at ASC`,
          [characterId, userId, days],
        );
        return rows.map((r) => r.summary);
      } catch {
        return [];
      }
    },
  };
}
