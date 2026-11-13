import { Pool } from 'pg';

// 建连接池（app 专用 Postgres，见 infra/postgres）。连接是惰性的，第一次 query 才真正连。
export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

// 建表（幂等）。通讯录一张表 + 长期记忆一张表（pgvector 向量）；以后 MBTI / 关系层都加在这里。
export async function ensureSchema(pool: Pool): Promise<void> {
  // pgvector（向量余弦检索）+ pg_trgm（中文词法相似度，混合召回的 lexical 腿）
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`);
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      name text PRIMARY KEY,
      added_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // 通话会话记录（L4 过度依赖的行为信号：近7天频率 / 单通时长 / 距上一通间隔）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      character_id text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      duration_seconds int
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS call_sessions_user_time_idx ON call_sessions (character_id, user_id, started_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      character_id text NOT NULL,        -- 哪个陪伴者记得的（按人物隔离用户画像；键 = persona.name）
      kind text NOT NULL,                -- constraint | fact | preference | episodic | insight
      content text NOT NULL,
      entity_id text,                    -- fact 的稳定实体键（如 user:job），空则不按实体覆盖
      embedding vector(1024),            -- 与 EMBEDDING_DIM 对齐（默认 1024）
      ttl_days int,                      -- episodic 默认 30；其余空（不衰减）
      access_count int NOT NULL DEFAULT 0,
      last_access timestamptz,
      superseded boolean NOT NULL DEFAULT false,
      superseded_at timestamptz,
      superseded_by uuid,
      version int NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // 迁移：老库的 memories 只有 user_id（所有人物共享一份画像）。补 character_id 并把存量回填到默认人物程书衡。
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS character_id text NOT NULL DEFAULT '程书衡'`);
  // 好奇心维度（原生家庭/职业/…），fact/preference/episodic 归入，constraint/insight 为空。
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS dimension text`);
  // 维度下的子槽（原生家庭→母亲等），边级延伸用；没有则空。
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS aspect text`);
  // 时间锚点（L5 时间感知）：记忆里的时间只能是绝对或周期，禁止相对。absolute→anchor_at；periodic→anchor_rule。
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS anchor_kind text`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS anchor_at date`);
  await pool.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS anchor_rule jsonb`);

  // 向量检索（HNSW 近似最近邻，只索引有向量的行）+ 按人物/用户/类型过滤 + 词法相似度
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories
      USING hnsw (embedding vector_cosine_ops)
  `);
  await pool.query(`DROP INDEX IF EXISTS memories_user_kind_idx`);
  await pool.query(`CREATE INDEX IF NOT EXISTS memories_character_user_kind_idx ON memories (character_id, user_id, kind)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS memories_content_trgm_idx ON memories USING gin (content gin_trgm_ops)`);
  // 时间锚点查询（临近/当天重要日期）：只索引绝对日期（周期走 jsonb 评估）。
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memories_anchor_idx ON memories (character_id, user_id, anchor_kind, anchor_at)
      WHERE anchor_at IS NOT NULL
  `);

  // 人设增补：陪伴者底座之外的软细节（爱好/口味/小回忆/习惯）。独立于用户长期记忆，
  // 按 character_id + user_id 隔离。提及驱动衰减：last_mentioned_at 越久越旧、archiveStale 归档。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS persona_additions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      character_id text NOT NULL,
      category text NOT NULL,
      content text NOT NULL,
      mention_count int NOT NULL DEFAULT 0,
      last_mentioned_at timestamptz NOT NULL DEFAULT now(),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS persona_additions_char_user_idx ON persona_additions (character_id, user_id, active)`);

  // 成长课题（Life Coach 的「重骨架」）：GROW 四段 + 生命周期，跨通话持久、按人物/用户隔离。
  // status：active（进行中，注入 [GOAL] 块）/ done（做成，庆祝后）/ archived（放下，可回溯不硬删）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_goals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      character_id text NOT NULL,
      title text NOT NULL,
      goal text,
      reality text,
      options text,
      will text,
      stage text NOT NULL DEFAULT 'goal',
      progress_note text,
      status text NOT NULL DEFAULT 'active',
      last_reviewed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS growth_goals_char_user_idx ON growth_goals (character_id, user_id, status)`);
}
