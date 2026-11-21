import { Pool } from 'pg';

// 建连接池（app 专用 Postgres，见 infra/postgres）。连接是惰性的，第一次 query 才真正连。
export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}

// 建表（幂等）。第一版、无历史数据，所有表都直接建最终 schema，不带任何存量迁移。
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
      persona_name text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      duration_seconds int
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS call_sessions_user_time_idx ON call_sessions (persona_name, user_id, started_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      persona_name text NOT NULL,        -- 哪个陪伴者记得的（按人物隔离用户画像；键 = persona.name）
      kind text NOT NULL,                -- constraint | fact | preference | episodic | profile
      content text NOT NULL,
      entity_id text,                    -- fact 的稳定实体键（如 user:job），空则不按实体覆盖
      dimension text,                    -- 好奇心维度（原生家庭/职业/…）；constraint/profile 为空
      aspect text,                       -- 维度下的子槽（原生家庭→母亲）；没有则空
      embedding vector(1024),            -- 与 EMBEDDING_DIM 对齐（默认 1024）
      ttl_days int,                      -- episodic 默认 30；其余空（不衰减）
      anchor_kind text,                  -- 时间锚点：absolute → anchor_at；periodic → anchor_rule
      anchor_at date,
      anchor_rule jsonb,
      access_count int NOT NULL DEFAULT 0,
      last_access timestamptz,
      superseded boolean NOT NULL DEFAULT false,
      superseded_at timestamptz,
      superseded_by uuid,
      version int NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // 向量检索（HNSW 近似最近邻，只索引有向量的行）+ 按人物/用户/类型过滤 + 词法相似度
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memories_embedding_idx ON memories
      USING hnsw (embedding vector_cosine_ops)
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS memories_persona_user_kind_idx ON memories (persona_name, user_id, kind)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS memories_content_trgm_idx ON memories USING gin (content gin_trgm_ops)`);
  // 时间锚点查询（临近/当天重要日期）：只索引绝对日期（周期走 jsonb 评估）。
  await pool.query(`
    CREATE INDEX IF NOT EXISTS memories_anchor_idx ON memories (persona_name, user_id, anchor_kind, anchor_at)
      WHERE anchor_at IS NOT NULL
  `);

  // 人设增补：陪伴者底座之外的软细节（爱好/口味/小回忆/习惯）。独立于用户长期记忆，
  // 按 persona_name + user_id 隔离。提及驱动衰减：last_mentioned_at 越久越旧、archiveStale 归档。
  // 表名 self_additions 对应 TS 类型 SelfAdded（contracts/selfAdded.ts），与「关于用户」的记忆类型 profile 无关。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS self_additions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      persona_name text NOT NULL,
      category text NOT NULL,
      content text NOT NULL,
      mention_count int NOT NULL DEFAULT 0,
      last_mentioned_at timestamptz NOT NULL DEFAULT now(),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS self_additions_persona_user_idx ON self_additions (persona_name, user_id, active)`);

  // 成长课题（Life Coach 的「重骨架」）：GROW 四段 + 生命周期，跨通话持久、按人物/用户隔离。
  // status：active（进行中，注入 [GOAL] 块）/ done（做成，庆祝后）/ archived（放下，可回溯不硬删）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS growth_goals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      persona_name text NOT NULL,
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
  await pool.query(`CREATE INDEX IF NOT EXISTS growth_goals_persona_user_idx ON growth_goals (persona_name, user_id, status)`);

  // 近 3 天已问过的问题（防重复提问）：每次提问记录一条，按人物/用户隔离。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS asked_questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      persona_name text NOT NULL,
      question text NOT NULL,
      asked_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS asked_questions_persona_user_time_idx ON asked_questions (persona_name, user_id, asked_at DESC)`);

  // 最近对话概要（跨通话的「最近聊过什么」）：每次通话结束记一条话题脉络，按人物/用户隔离。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      persona_name text NOT NULL,
      summary text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS conversation_summaries_persona_user_time_idx ON conversation_summaries (persona_name, user_id, created_at DESC)`);

  // 逐轮聊天记录（导出/优化用）：正文 + 每轮元数据（情绪/声学/哭笑事件/延迟/框架/是否问句）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_turns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL,
      persona_name text NOT NULL,
      session_id uuid,
      role text NOT NULL,                 -- user | agent
      text text NOT NULL,
      turn_index int NOT NULL,
      emotion text,                       -- agent 本轮情绪（warm/tender/steady/natural）
      affect jsonb,                       -- user 本轮 affect（valence/arousal/dominance/incongruence）
      acoustic jsonb,                     -- user 本轮声学特征（rateZ/pitchZ/loudnessZ/pauseZ）
      vocals jsonb,                       -- 本轮哭/笑事件
      recalled jsonb,                     -- agent 本轮实际注入的记忆（id/kind/content）
      latency_ms int,                     -- user 说完→AI 开口 延迟
      frame text,                         -- friend | coach
      mode text,                          -- casual | careful
      stance text,                        -- guide | accompany
      asked boolean,                      -- agent 这句是否在等回应
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS call_turns_persona_user_time_idx ON call_turns (persona_name, user_id, created_at DESC)`);

  // 结构化身份（做梦时反思抽取）：field→value 单值覆盖，不做自由文本记忆。字段名动态（中文名/昵称/宠物…）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_identity (
      persona_name text NOT NULL,
      user_id text NOT NULL,
      field text NOT NULL,
      value text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (persona_name, user_id, field)
    )
  `);

  // 做梦运行记录（前端展示「做梦具体做了什么」用）：计数 + details jsonb（实际写下的内容）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dream_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      persona_name text NOT NULL,
      user_id text NOT NULL,
      states int NOT NULL DEFAULT 0,
      identity int NOT NULL DEFAULT 0,
      profile int NOT NULL DEFAULT 0,
      merged int NOT NULL DEFAULT 0,
      resolved int NOT NULL DEFAULT 0,
      details jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS dream_runs_persona_user_time_idx ON dream_runs (persona_name, user_id, created_at DESC)`);
  // 迁移：近况（state）记忆型引入后，dream_runs 的 facts 列改名 states（老库才有 facts 列；新库已建 states，此句 no-op）。
  await pool.query(`ALTER TABLE dream_runs RENAME COLUMN facts TO states`).catch(() => {});
}
