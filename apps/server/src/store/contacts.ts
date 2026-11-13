import type { Pool } from 'pg';

// 初始默认伙伴：新库第一次启动时预置苏明悦（当前唯一默认），其余暂不上线。
// 只在通讯录为空时播种一次，避免覆盖用户后续自己增删的结果。
const DEFAULT_CONTACTS = ['苏明悦'];

// 通讯录：Postgres 持久化（表结构见 db.ts ensureSchema）。
export function createContactsStore(pool: Pool) {
  const list = async (): Promise<string[]> => {
    const { rows } = await pool.query('SELECT name FROM contacts ORDER BY added_at ASC, name ASC');
    return rows.map((r) => r.name as string);
  };

  return {
    list,
    async seedDefaults(): Promise<void> {
      const { rows } = await pool.query('SELECT count(*)::int AS c FROM contacts');
      if (rows[0].c > 0) return; // 已有伙伴则不播种（尊重用户增删）
      for (const name of DEFAULT_CONTACTS) {
        await pool.query('INSERT INTO contacts (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
      }
    },
    async add(name: string): Promise<string[]> {
      await pool.query('INSERT INTO contacts (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
      return list();
    },
    async remove(name: string): Promise<string[]> {
      await pool.query('DELETE FROM contacts WHERE name = $1', [name]);
      return list();
    },
  };
}
