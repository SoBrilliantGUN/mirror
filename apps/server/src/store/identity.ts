import type { Pool } from 'pg';
import type { IdentityField, IdentityStore } from '@mirror/contracts';

// 结构化身份存储：field→value 单值覆盖（UPSERT），按 persona_name + user_id 隔离。
// 同一字段新值覆盖旧值，天然无重复——身份是「对方是谁」的基本信息，不该是自由文本记忆。
export function createIdentityStore(pool: Pool): IdentityStore {
  return {
    async list(personaName, userId): Promise<IdentityField[]> {
      const { rows } = await pool.query<{ field: string; value: string }>(
        `SELECT field, value FROM user_identity
          WHERE persona_name = $1 AND user_id = $2
          ORDER BY field`,
        [personaName, userId],
      );
      return rows.map((r) => ({ field: r.field, value: r.value }));
    },

    async upsert(personaName, userId, fields): Promise<void> {
      for (const f of fields) {
        const field = (f.field ?? '').trim();
        const value = (f.value ?? '').trim();
        if (!field || !value) continue;
        await pool.query(
          `INSERT INTO user_identity (persona_name, user_id, field, value)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (persona_name, user_id, field)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [personaName, userId, field, value],
        );
      }
    },
  };
}
