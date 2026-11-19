// 内嵌 PostgreSQL（embedded-postgres，PG16）+ 已塞入的 pgvector/pg_trgm。
import EmbeddedPostgres from 'embedded-postgres';
import { Client } from 'pg';
import { app } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const PORT = 5432;
const USER = 'postgres';
const PASS = 'postgres';
const DB = 'mirror';

let pg: EmbeddedPostgres | null = null;

const url = (db: string) => `postgresql://${USER}:${PASS}@localhost:${PORT}/${db}`;

// 探测某个库是否可达（用于判断「崩溃残留的 postgres 是否还在跑」）。
async function ping(db: string): Promise<boolean> {
  const c = new Client({ connectionString: url(db), connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

// 确保 mirror 库存在（幂等）。
async function ensureDatabase(): Promise<void> {
  const c = new Client({ connectionString: url('postgres') });
  await c.connect();
  try {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB]);
    if (r.rowCount === 0) await c.query(`CREATE DATABASE "${DB}"`);
  } finally {
    await c.end();
  }
}

export async function startPostgres(): Promise<string> {
  const dataDir = join(app.getPath('userData'), 'pgdata');
  pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    port: PORT,
    user: USER,
    password: PASS,
    persistent: true,
    autoRehydrateSymlinks: true,
    // 中文 Windows 的 GBK 系统 locale 会让 initdb 告警回退，这里显式钉死 UTF8 + C locale。
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: (m) => console.log('[pg]', m.trim()),
    onError: (e) => console.error('[pg:err]', String(e)),
  });

  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    await pg.initialise();
  }

  try {
    await pg.start();
  } catch (e) {
    // 上次崩溃残留的 postgres 还在跑（postmaster.pid 已存在）→ 直连复用，别硬起第二个。
    if (await ping('postgres')) {
      await ensureDatabase();
      return url(DB);
    }
    throw e;
  }

  await ensureDatabase();
  return url(DB);
}

export async function stopPostgres(): Promise<void> {
  if (pg) {
    try {
      await pg.stop();
    } catch {
      /* 忽略 */
    }
    pg = null;
  }
}
