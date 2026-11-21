import type { Pool } from 'pg';
import type { DreamDetails, DreamResult } from '../brain/consolidate/dream';

// 做梦运行记录：前端展示「做梦具体做了什么」用。除计数外，把实际内容存进 details jsonb。
export type DreamRunRow = {
  personaName: string;
  createdAt: string;
  details: DreamDetails;
};

const EMPTY_DETAILS: DreamDetails = { facts: [], identity: [], profile: [], merged: [], resolved: [] };

export function createDreamRunsStore(pool: Pool) {
  return {
    async log(personaName: string, userId: string, r: DreamResult): Promise<void> {
      await pool.query(
        `INSERT INTO dream_runs (persona_name, user_id, facts, identity, profile, merged, resolved, details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
        [personaName, userId, r.abstractedFacts, r.abstractedIdentity, r.abstractedProfile, r.merged, r.resolved, JSON.stringify(r.details)],
      );
    },

    async recent(personaName: string, userId: string, limit = 20): Promise<DreamRunRow[]> {
      const { rows } = await pool.query(
        `SELECT persona_name, details, created_at
           FROM dream_runs
          WHERE persona_name = $1 AND user_id = $2
          ORDER BY created_at DESC LIMIT $3`,
        [personaName, userId, limit],
      );
      return rows.map((r) => ({
        personaName: r.persona_name,
        createdAt: new Date(r.created_at).toISOString(),
        details: (r.details ?? EMPTY_DETAILS) as DreamDetails,
      }));
    },
  };
}
