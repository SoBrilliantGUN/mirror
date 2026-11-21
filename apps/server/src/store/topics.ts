import type { Pool } from 'pg';

// 话题参与 + 备用话题库存储。表结构见 db.ts ensureSchema 的 topic_engagements / topic_library。
export type TopicSessionStats = { topic: string; sessions: number; engagedSessions: number };
export type TopicLibraryEntry = { topic: string; summary: string; createdAt: string };

export function createTopicsStore(pool: Pool) {
  return {
    // 记录一次主题参与（每通电话结束后逐条写入）。
    async recordEngagement(
      personaName: string,
      userId: string,
      e: { topic: string; sessionId: string | null; engaged: boolean; turns: number },
    ): Promise<void> {
      await pool.query(
        `INSERT INTO topic_engagements (persona_name, user_id, topic, session_id, engaged, turns)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [personaName, userId, e.topic, e.sessionId, e.engaged, e.turns],
      );
    },

    // 每个主题出现在几通电话里（按 session 去重）+ 深入聊过的通话数。
    async topicSessionStats(personaName: string, userId: string): Promise<TopicSessionStats[]> {
      const { rows } = await pool.query(
        `SELECT topic,
                COUNT(DISTINCT session_id) AS sessions,
                COUNT(DISTINCT session_id) FILTER (WHERE engaged) AS engaged_sessions
           FROM topic_engagements
          WHERE persona_name = $1 AND user_id = $2
          GROUP BY topic`,
        [personaName, userId],
      );
      return rows.map((r) => ({
        topic: r.topic as string,
        sessions: Number(r.sessions),
        engagedSessions: Number(r.engaged_sessions),
      }));
    },

    // 某主题是否已存过素材。
    async hasLibraryTopic(personaName: string, userId: string, topic: string): Promise<boolean> {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM topic_library WHERE persona_name = $1 AND user_id = $2 AND topic = $3 LIMIT 1`,
        [personaName, userId, topic],
      );
      return (rowCount ?? 0) > 0;
    },

    // 存一条搜索总结到备用话题库。
    async saveLibrary(personaName: string, userId: string, topic: string, summary: string): Promise<void> {
      await pool.query(
        `INSERT INTO topic_library (persona_name, user_id, topic, summary) VALUES ($1, $2, $3, $4)`,
        [personaName, userId, topic, summary],
      );
    },

    // 取最近 N 条备用话题素材（找话题时注入）。
    async listLibrary(personaName: string, userId: string, limit = 10): Promise<TopicLibraryEntry[]> {
      const { rows } = await pool.query(
        `SELECT topic, summary, created_at FROM topic_library
          WHERE persona_name = $1 AND user_id = $2
          ORDER BY created_at DESC LIMIT $3`,
        [personaName, userId, limit],
      );
      return rows.map((r) => ({
        topic: r.topic as string,
        summary: r.summary as string,
        createdAt: new Date(r.created_at).toISOString(),
      }));
    },
  };
}

export type TopicsStore = ReturnType<typeof createTopicsStore>;
