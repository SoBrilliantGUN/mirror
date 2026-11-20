import type { Pool } from 'pg';
import type { DependenceSignals } from '@mirror/contracts';

// 通话会话记录（L4 过度依赖的行为信号来源）：表结构见 db.ts ensureSchema。
// 每通开始插一条，挂断补 ended_at + duration；近7天频率 / 单通时长 / 距上一通间隔 由它聚合。
export function createSessionsStore(pool: Pool) {
  return {
    // 开一条会话记录，返回 id（挂断时用它补 ended_at）。
    async start(personaName: string, userId: string): Promise<string> {
      const { rows } = await pool.query(
        'INSERT INTO call_sessions (character_id, user_id) VALUES ($1, $2) RETURNING id',
        [personaName, userId],
      );
      return rows[0].id as string;
    },

    // 挂断：补结束时间与时长（失败只告警，不阻断挂断）。
    async end(id: string): Promise<void> {
      await pool.query(
        `UPDATE call_sessions
           SET ended_at = now(),
               duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at))::int)
         WHERE id = $1`,
        [id],
      );
    },

    // 过度依赖行为信号：纯确定性，不进 LLM。
    async signals(personaName: string, userId: string, currentId: string): Promise<DependenceSignals> {
      const [cur, cnt, prev] = await Promise.all([
        pool.query('SELECT started_at FROM call_sessions WHERE id = $1', [currentId]),
        pool.query(
          `SELECT count(*)::int AS c FROM call_sessions
            WHERE character_id = $1 AND user_id = $2 AND started_at >= now() - interval '7 days'`,
          [personaName, userId],
        ),
        pool.query(
          `SELECT started_at, ended_at FROM call_sessions
            WHERE character_id = $1 AND user_id = $2 AND id <> $3
            ORDER BY started_at DESC LIMIT 1`,
          [personaName, userId, currentId],
        ),
      ]);

      const startedAt = cur.rows[0]?.started_at ? new Date(cur.rows[0].started_at as string) : new Date();
      const currentCallMinutes = Math.floor((Date.now() - startedAt.getTime()) / 60000);

      let lastGapMinutes: number | null = null;
      const prevRow = prev.rows[0];
      if (prevRow) {
        const prevEnded = prevRow.ended_at ? new Date(prevRow.ended_at as string) : new Date(prevRow.started_at as string);
        lastGapMinutes = Math.floor((startedAt.getTime() - prevEnded.getTime()) / 60000);
      }

      return {
        recentCalls7d: cnt.rows[0]?.c ?? 0,
        currentCallMinutes,
        lastGapMinutes,
      };
    },
  };
}

export type SessionsStore = ReturnType<typeof createSessionsStore>;
