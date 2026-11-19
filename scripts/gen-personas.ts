// L6 构建期生成：把 character/<姓名>/ 的角色卡 + 记忆索引 → 结构化 Persona（server）+ Companion（client）。
// 唯一事实源 = character/。生成物 gitignore、不进 git，构建/启动前跑本脚本（npm run gen:personas）。
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHARACTER_DIR = join(ROOT, 'character');
const SERVER_OUT = join(ROOT, 'apps', 'server', 'src', 'persona', 'generated.ts');
const CLIENT_OUT = join(ROOT, 'apps', 'client', 'app', 'companions.generated.ts');

// 展示顺序 = 16 型固定序（与 character/README.md 索引一致，不依赖文件系统顺序）。
const MBTI_ORDER = ['ISTJ', 'ISFJ', 'INFJ', 'INTJ', 'ISTP', 'ISFP', 'INFP', 'INTP', 'ESTP', 'ESFP', 'ENFP', 'ENTP', 'ESTJ', 'ESFJ', 'ENFJ', 'ENTJ'];
const GENDERS = new Set(['男', '女']);

type RawPersona = {
  name: string; mbti: string; gender: string;
  temperament: string; profession: string; intro: string; style: string; strength: string;
  color: string; rate: number; voiceId: string; voiceTint: string; available: boolean;
  body: string; index: string;
};

const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

// 解析 flat frontmatter：--- 分隔，行级 key: value（值取字面，内部引号/标点照常）。
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2] };
}

function requireField(meta: Record<string, string>, key: string, name: string): string {
  const v = meta[key];
  if (v == null || v === '') throw new Error(`[${name}] 缺字段 ${key}`);
  return v;
}

function parseCard(name: string): RawPersona {
  const dir = join(CHARACTER_DIR, name);
  const cardPath = join(dir, '角色卡.md');
  if (!existsSync(cardPath)) throw new Error(`[${name}] 缺 角色卡.md`);
  const { meta, body } = parseFrontmatter(read(cardPath));

  // 构建即校验：字段缺失/非法直接抛错，构建失败。
  const metaName = meta.name;
  if (metaName != null && metaName !== name) throw new Error(`[${name}] frontmatter name「${metaName}」≠ 文件夹名「${name}」`);
  const mbti = requireField(meta, 'mbti', name);
  if (!MBTI_ORDER.includes(mbti)) throw new Error(`[${name}] mbti 非法：${mbti}`);
  const gender = requireField(meta, 'gender', name);
  if (!GENDERS.has(gender)) throw new Error(`[${name}] gender 非法：${gender}`);
  const color = requireField(meta, 'color', name);
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`[${name}] color 非 hex：${color}`);
  const available = meta.available;
  if (available !== 'true' && available !== 'false') throw new Error(`[${name}] available 非布尔：${available}`);
  const rateRaw = meta.rate;
  const rate = rateRaw == null || rateRaw === '' ? 1.0 : Number(rateRaw);
  if (Number.isNaN(rate)) throw new Error(`[${name}] rate 非法：${rateRaw}`);
  if (body.trim() === '') throw new Error(`[${name}] 角色卡无正文`);
  if (!body.includes(`# ${name}`)) throw new Error(`[${name}] 正文标题与 frontmatter name 不一致`);

  const indexPath = join(dir, '记忆.md');
  const index = existsSync(indexPath) ? read(indexPath).trim() : '';

  return {
    name, mbti, gender,
    temperament: requireField(meta, 'temperament', name),
    profession: requireField(meta, 'profession', name),
    intro: requireField(meta, 'intro', name),
    style: requireField(meta, 'style', name),
    strength: requireField(meta, 'strength', name),
    color, rate,
    voiceId: requireField(meta, 'voiceId', name),
    voiceTint: meta.voiceTint ?? '',
    available: available === 'true',
    body: body.trim(), index,
  };
}

// 常驻底座 = 角色卡正文 + 记忆索引（关系已删，由 insight 承载）。等价于原 composePersonaPrompt 上移到构建期。
function composeSystemPrompt(p: RawPersona): string {
  const parts = [p.body];
  if (p.index) parts.push(`【记忆索引】\n${p.index}`);
  return parts.join('\n\n');
}

function main() {
  const names = readdirSync(CHARACTER_DIR).filter((f) => existsSync(join(CHARACTER_DIR, f, '角色卡.md')));
  if (names.length === 0) throw new Error('character/ 下没有可解析的角色卡');
  const personas = names.map(parseCard);
  const sorted = [...personas].sort((a, b) => MBTI_ORDER.indexOf(a.mbti) - MBTI_ORDER.indexOf(b.mbti));

  // —— server：PERSONAS ——
  const serverLines: string[] = [];
  serverLines.push('// 由 scripts/gen-personas.ts 生成，勿手改。唯一事实源：character/<姓名>/。');
  serverLines.push("import type { Persona } from '@mirror/contracts';");
  serverLines.push('');
  serverLines.push('export const PERSONAS: Record<string, Persona> = {');
  for (const p of personas.filter((p) => p.available)) {
    serverLines.push(`  ${JSON.stringify(p.name)}: {`);
    serverLines.push(`    name: ${JSON.stringify(p.name)},`);
    serverLines.push(`    mbti: ${JSON.stringify(p.mbti)},`);
    serverLines.push(`    gender: ${JSON.stringify(p.gender)},`);
    serverLines.push(`    voiceId: ${JSON.stringify(p.voiceId)},`);
    serverLines.push(`    voiceTint: ${JSON.stringify(p.voiceTint)},`);
    serverLines.push(`    available: ${p.available},`);
    serverLines.push(`    rate: ${p.rate},`);
    serverLines.push(`    systemPrompt: ${JSON.stringify(composeSystemPrompt(p))},`);
    serverLines.push('  },');
  }
  serverLines.push('};');
  serverLines.push('');

  // —— client：COMPANIONS ——
  const clientLines: string[] = [];
  clientLines.push('// 由 scripts/gen-personas.ts 生成，勿手改。唯一事实源：character/<姓名>/。');
  clientLines.push('export type Companion = {');
  clientLines.push('  name: string;');
  clientLines.push("  gender: '男' | '女';");
  clientLines.push('  temperament: string;');
  clientLines.push('  profession: string;');
  clientLines.push('  intro: string;');
  clientLines.push('  style: string;');
  clientLines.push('  strength: string;');
  clientLines.push('  color: string;');
  clientLines.push('  available: boolean;');
  clientLines.push('};');
  clientLines.push('');
  clientLines.push('export const COMPANIONS: Companion[] = [');
  for (const p of sorted.filter((p) => p.available)) {
    clientLines.push('  {');
    clientLines.push(`    name: ${JSON.stringify(p.name)},`);
    clientLines.push(`    gender: ${JSON.stringify(p.gender)},`);
    clientLines.push(`    temperament: ${JSON.stringify(p.temperament)},`);
    clientLines.push(`    profession: ${JSON.stringify(p.profession)},`);
    clientLines.push(`    intro: ${JSON.stringify(p.intro)},`);
    clientLines.push(`    style: ${JSON.stringify(p.style)},`);
    clientLines.push(`    strength: ${JSON.stringify(p.strength)},`);
    clientLines.push(`    color: ${JSON.stringify(p.color)},`);
    clientLines.push(`    available: ${p.available},`);
    clientLines.push('  },');
  }
  clientLines.push('];');
  clientLines.push('');

  mkdirSync(dirname(SERVER_OUT), { recursive: true });
  mkdirSync(dirname(CLIENT_OUT), { recursive: true });
  writeFileSync(SERVER_OUT, serverLines.join('\n'));
  writeFileSync(CLIENT_OUT, clientLines.join('\n'));

  const online = personas.filter((p) => p.available).map((p) => p.name);
  console.log(`[gen-personas] 解析 ${personas.length} 位（上线 ${online.length}：${online.join('、')}）`);
  console.log(`[gen-personas] → ${SERVER_OUT.replace(ROOT + '/', '')}`);
  console.log(`[gen-personas] → ${CLIENT_OUT.replace(ROOT + '/', '')}`);
}

main();
