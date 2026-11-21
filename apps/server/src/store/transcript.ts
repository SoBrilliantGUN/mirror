import type { Pool } from 'pg';

// 逐轮聊天记录（导出/优化用）：表结构见 db.ts ensureSchema 的 call_turns。
// 每轮落一条 user / agent 正文 + 元数据，供 GET /export/chat 结构化导出。
// 用户消息落三版：raw_text（ASR 原始）、name_corrected（名字纠正后）、text（正文纠错后 = 最终版）。
export type TurnInsert = {
  sessionId?: string | null;
  role: 'user' | 'agent';
  text: string;
  rawText?: string | null;        // 用户消息：ASR 原始识别（纠错前）
  nameCorrected?: string | null;  // 用户消息：名字纠正后的中间版
  turnIndex: number;
  emotion?: string | null;
  affect?: unknown;
  acoustic?: unknown;
  vocals?: unknown;
  recalled?: unknown;
  latencyMs?: number | null;
  frame?: string | null;
  mode?: string | null;
  stance?: string | null;
  asked?: boolean | null;
};

export type TurnRow = {
  id: string;
  role: 'user' | 'agent';
  text: string;
  rawText: string | null;
  nameCorrected: string | null;
  turnIndex: number;
  sessionId: string | null;
  emotion: string | null;
  affect: unknown;
  acoustic: unknown;
  vocals: unknown;
  recalled: unknown;
  latencyMs: number | null;
  frame: string | null;
  mode: string | null;
  stance: string | null;
  asked: boolean | null;
  createdAt: string;
};

export function createTranscriptStore(pool: Pool) {
  return {
    async insert(personaName: string, userId: string, t: TurnInsert): Promise<void> {
      await pool.query(
        `INSERT INTO call_turns
           (persona_name, user_id, session_id, role, text, raw_text, name_corrected, turn_index, emotion, affect, acoustic, vocals, recalled, latency_ms, frame, mode, stance, asked)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
        [
          personaName,
          userId,
          t.sessionId ?? null,
          t.role,
          t.text,
          t.rawText ?? null,
          t.nameCorrected ?? null,
          t.turnIndex,
          t.emotion ?? null,
          t.affect ? JSON.stringify(t.affect) : null,
          t.acoustic ? JSON.stringify(t.acoustic) : null,
          t.vocals ? JSON.stringify(t.vocals) : null,
          t.recalled ? JSON.stringify(t.recalled) : null,
          t.latencyMs ?? null,
          t.frame ?? null,
          t.mode ?? null,
          t.stance ?? null,
          t.asked ?? null,
        ],
      );
    },

    async list(
      personaName: string,
      userId: string,
      opts?: { since?: string; limit?: number },
    ): Promise<TurnRow[]> {
      const params: unknown[] = [personaName, userId];
      let where = 'persona_name = $1 AND user_id = $2';
      if (opts?.since) {
        params.push(opts.since);
        where += ` AND created_at >= $${params.length}`;
      }
      const limit = opts?.limit && opts.limit > 0 ? Math.min(opts.limit, 10000) : 2000;
      params.push(limit);
      const { rows } = await pool.query(
        `SELECT id, session_id, role, text, raw_text, name_corrected, turn_index, emotion, affect, acoustic, vocals, recalled, latency_ms, frame, mode, stance, asked, created_at
           FROM call_turns
          WHERE ${where}
          ORDER BY created_at ASC, turn_index ASC
          LIMIT $${params.length}`,
        params,
      );
      return rows.map((r) => ({
        id: r.id as string,
        sessionId: r.session_id as string | null,
        role: r.role as 'user' | 'agent',
        text: r.text as string,
        rawText: r.raw_text as string | null,
        nameCorrected: r.name_corrected as string | null,
        turnIndex: r.turn_index as number,
        emotion: r.emotion as string | null,
        affect: r.affect,
        acoustic: r.acoustic,
        vocals: r.vocals,
        recalled: r.recalled,
        latencyMs: r.latency_ms as number | null,
        frame: r.frame as string | null,
        mode: r.mode as string | null,
        stance: r.stance as string | null,
        asked: r.asked as boolean | null,
        createdAt: r.created_at as string,
      }));
    },
  };
}

export type TranscriptStore = ReturnType<typeof createTranscriptStore>;
