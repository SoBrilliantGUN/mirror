import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { SelfAdded, SelfAddedStore } from '@mirror/contracts';

// 人设增补存储：陪伴者底座之外的软细节（爱好/口味/小回忆/习惯）。独立于用户长期记忆。
// 每条按 character_id + user_id 隔离（同用户画像隔离原则）。提及驱动衰减：listActive 只出活跃条，
// touch 刷新 last_mentioned_at（对话中再次被触碰），archiveStale 把长期未提及的归档（active=false，不硬删）。

type Row = {
  id: string;
  user_id: string;
  character_id: string;
  category: string;
  content: string;
  mention_count: number;
  last_mentioned_at: Date | string;
  active: boolean;
  created_at: Date | string;
};

function toSelfAdded(r: Row): SelfAdded {
  return {
    id: r.id,
    userId: r.user_id,
    characterId: r.character_id,
    category: r.category,
    content: r.content,
    mentionCount: r.mention_count,
    lastMentionedAt: r.last_mentioned_at ? new Date(r.last_mentioned_at).toISOString() : null,
    active: r.active,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export function createSelfAddedStore(pool: Pool): SelfAddedStore {
  return {
    async listActive(characterId, userId): Promise<SelfAdded[]> {
      const { rows } = await pool.query<Row>(
        `SELECT * FROM persona_additions WHERE character_id = $1 AND user_id = $2 AND active ORDER BY created_at ASC`,
        [characterId, userId],
      );
      return rows.map(toSelfAdded);
    },

    async write(characterId, userId, { category, content }): Promise<SelfAdded> {
      const id = randomUUID();
      await pool.query(
        `INSERT INTO persona_additions (id, character_id, user_id, category, content) VALUES ($1, $2, $3, $4, $5)`,
        [id, characterId, userId, category, content],
      );
      const { rows } = await pool.query<Row>(`SELECT * FROM persona_additions WHERE id = $1`, [id]);
      return toSelfAdded(rows[0]);
    },

    async touch(characterId, userId, ids): Promise<void> {
      if (ids.length === 0) return;
      await pool.query(
        `UPDATE persona_additions SET mention_count = mention_count + 1, last_mentioned_at = now() WHERE character_id = $1 AND user_id = $2 AND id = ANY($3::uuid[])`,
        [characterId, userId, ids],
      );
    },

    async archiveStale(characterId, userId, ttlDays): Promise<number> {
      const { rows } = await pool.query<{ id: string }>(
        `UPDATE persona_additions SET active = false
          WHERE character_id = $1 AND user_id = $2 AND active
            AND last_mentioned_at < now() - make_interval(days => $3)
          RETURNING id`,
        [characterId, userId, ttlDays],
      );
      return rows.length;
    },
  };
}
