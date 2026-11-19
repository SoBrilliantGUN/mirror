// 一次性存量迁移：对已落库的记忆，用「写入当时（created_at）」作参照，程序化检测时间 → 回填锚点，
// 并把 content 里的相对词（今天/下周三/下个月/明年）改写成折算后的具体日期。
// 用法：npx tsx apps/server/src/scripts/migrate-time-anchor.ts [persona名]
//   不带参数 = 遍历所有上线 persona（没数据的自动跳过）；带参数 = 只迁那一位。
import { loadDotEnv, loadConfig } from '../config';
import { createPool, ensureSchema } from '../store/db';
import { parseTimeAnchor, rewriteRelativeTime } from '../brain/timeAnchor';
import { PERSONAS } from '../persona';

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  await ensureSchema(pool);
  const userId = 'demo-user';

  const targets = process.argv[2]
    ? [process.argv[2]]
    : Object.values(PERSONAS).filter((p) => p.available).map((p) => p.name);

  for (const characterId of targets) {
    const { rows } = await pool.query<{
      id: string; kind: string; content: string; created_at: Date; anchor_kind: string | null;
    }>(
      `SELECT id, kind, content, created_at, anchor_kind
         FROM memories WHERE character_id = $1 AND user_id = $2 AND NOT superseded`,
      [characterId, userId],
    );
    if (rows.length === 0) {
      console.log(`[${characterId}] 无活跃记忆，跳过\n`);
      continue;
    }

    let anchored = 0;
    let rewritten = 0;
    for (const r of rows) {
      // 相对词是「写入当时」相对说的，用 created_at 当「今天」参照，而不是迁移时的 now。
      const ref = new Date(r.created_at);
      const anchor = parseTimeAnchor(r.content, ref);
      const newContent = rewriteRelativeTime(r.content, ref);

      if (anchor && !r.anchor_kind) {
        await pool.query(
          `UPDATE memories SET anchor_kind = $2, anchor_at = $3, anchor_rule = $4::jsonb WHERE id = $1`,
          [
            r.id,
            anchor.kind,
            anchor.kind === 'absolute' ? anchor.at : null,
            anchor.kind === 'periodic' ? JSON.stringify(anchor.rule) : null,
          ],
        );
        anchored++;
        console.log(`  [anchor] ${r.kind} → ${JSON.stringify(anchor)}：${r.content}`);
      }
      if (newContent !== r.content) {
        await pool.query(`UPDATE memories SET content = $2 WHERE id = $1`, [r.id, newContent]);
        rewritten++;
        console.log(`  [rewrite] ${r.kind}：${r.content}\n            → ${newContent}`);
      }
    }
    console.log(`[${characterId}] 回填锚点 ${anchored} 条，改写相对词 ${rewritten} 条\n`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
