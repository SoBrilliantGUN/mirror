// 纯逻辑冒烟测试：记忆分类解析 / RRF 融合 / token 估算 / 分层装配 / 上下文压缩。
// 运行：npm test
import { strict as assert } from 'node:assert';
import type { RecalledMemories } from '@mirror/contracts';
import { parseMemoryType } from '../src/brain/memoryClassifier';
import { parseReflection } from '../src/brain/consolidate/reflect';
import { rrfFuse } from '../src/store/memory';
import {
  estimateTokens,
  formatMemoryBlock,
  formatStateBlock,
  formatHistory,
  type HistoryEntry,
} from '../src/brain/context';
import { compressHistory, pickLevel, estimateHistoryTokens, historyToText } from '../src/brain/compress';
import { parseDetail, formatPersonaBlock, type PersonaDetail } from '../src/persona/loadPersona';
import { cosine } from '../src/vector';
import { parseExtraction, parseRetraction } from '../src/brain/consolidate/memoryTurn';
import { mergeRecalled } from '../src/brain/assemble';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const recalled = (c: string[] = [], f: string[] = [], p: string[] = [], e: string[] = [], i: string[] = []): RecalledMemories => ({
  constraint: c.map((x) => ({ id: x, userId: 'u', characterId: 'c', kind: 'constraint' as const, content: x, entityId: null, dimension: null, aspect: null, accessCount: 0, lastAccess: null, superseded: false, version: 1, createdAt: '' })),
  profile: i.map((x) => ({ id: x, userId: 'u', characterId: 'c', kind: 'profile' as const, content: x, entityId: null, dimension: null, aspect: null, accessCount: 0, lastAccess: null, superseded: false, version: 1, createdAt: '' })),
  fact: f.map((x) => ({ id: x, userId: 'u', characterId: 'c', kind: 'fact' as const, content: x, entityId: null, dimension: null, aspect: null, accessCount: 0, lastAccess: null, superseded: false, version: 1, createdAt: '' })),
  preference: p.map((x) => ({ id: x, userId: 'u', characterId: 'c', kind: 'preference' as const, content: x, entityId: null, dimension: null, aspect: null, accessCount: 0, lastAccess: null, superseded: false, version: 1, createdAt: '' })),
  episodic: e.map((x) => ({ id: x, userId: 'u', characterId: 'c', kind: 'episodic' as const, content: x, entityId: null, dimension: null, aspect: null, accessCount: 0, lastAccess: null, superseded: false, version: 1, createdAt: '' })),
});

const turn = (text: string, role: 'user' | 'agent' = 'user'): HistoryEntry => ({ kind: 'turn', role, text });

console.log('parseMemoryType（记忆分类解析）');
ok('标准 JSON → fact', () => assert.equal(parseMemoryType('{"memory_type":"fact"}'), 'fact'));
ok('包 markdown 代码块 → constraint', () => {
  assert.equal(parseMemoryType('```json\n{"memory_type":"constraint"}\n```'), 'constraint');
});
ok('非法类型 → null', () => assert.equal(parseMemoryType('{"memory_type":"bogus"}'), null));
ok('纯垃圾 → null', () => assert.equal(parseMemoryType('你好'), null));

console.log('rrfFuse（多路召回融合）');
ok('两路都出现的排最前', () => {
  const fused = rrfFuse([
    [{ item: 'a', score: 1 }, { item: 'b', score: 0.5 }],
    [{ item: 'b', score: 1 }, { item: 'c', score: 0.5 }],
  ]);
  assert.equal(fused[0].item, 'b');
});
ok('空列表融合为空', () => assert.equal(rrfFuse([]).length, 0));

console.log('estimateTokens（token 估算）');
ok('空串 → 0', () => assert.equal(estimateTokens(''), 0));
ok('中文按 ~1 token/1.5 字符', () => {
  const t = estimateTokens('一二三四五六');
  assert.ok(t >= 3 && t <= 5, `got ${t}`);
});

console.log('formatMemoryBlock（L2 记忆块）');
ok('空记忆 → 空串', () => assert.equal(formatMemoryBlock(recalled(), 1000), ''));
ok('含 [MEMORY] 标记，约束排最前', () => {
  const block = formatMemoryBlock(recalled(['不要深夜逼问她'], ['她在准备考研'], [], []), 1000);
  assert.ok(block.startsWith('[MEMORY]'));
  assert.ok(block.indexOf('约束') < block.indexOf('事实'));
  assert.ok(block.includes('不要深夜逼问她'));
});
ok('人设在约束之后、事实之前', () => {
  const block = formatMemoryBlock(recalled(['红线'], ['事实'], [], [], ['她的课题']), 1000);
  assert.ok(block.indexOf('约束') < block.indexOf('人设'));
  assert.ok(block.indexOf('人设') < block.indexOf('事实'));
  assert.ok(block.includes('她的课题'));
});

console.log('parseReflection（反思输出解析）');
ok('标准 JSON → facts + profile', () => {
  const r = parseReflection('{"facts":[{"content":"她在准备转行","entityId":"user:goal"}],"profile":["一提工作就唤醒飙升"]}');
  assert.equal(r.facts.length, 1);
  assert.equal(r.facts[0].content, '她在准备转行');
  assert.equal(r.profile[0], '一提工作就唤醒飙升');
});
ok('包 markdown 代码块也能解析', () => {
  const r = parseReflection('```json\n{"facts":[],"profile":["x"]}\n```');
  assert.equal(r.profile[0], 'x');
});
ok('纯垃圾 → 空', () => {
  const r = parseReflection('你好');
  assert.equal(r.facts.length, 0);
  assert.equal(r.profile.length, 0);
});

console.log('parseExtraction（后台抽取解析）');
ok('标准 JSON → 记忆列表', () => {
  const r = parseExtraction('{"memories":[{"content":"她在准备考研","kind":"fact"},{"content":"喜欢晚上散步","kind":"preference"}]}');
  assert.equal(r.length, 2);
  assert.equal(r[0].content, '她在准备考研');
  assert.equal(r[0].kind, 'fact');
});
ok('非法 kind 被过滤', () => {
  const r = parseExtraction('{"memories":[{"content":"x","kind":"bogus"},{"content":"y","kind":"episodic"}]}');
  assert.equal(r.length, 1);
  assert.equal(r[0].content, 'y');
});
ok('纯垃圾 → 空', () => assert.equal(parseExtraction('你好').length, 0));

console.log('parseRetraction（纠正撤销解析）');
ok('标准 retract 列表', () => {
  assert.deepEqual(parseRetraction('{"memories":[],"retract":["签证","全栈"]}'), ['签证', '全栈']);
});
ok('包 markdown 代码块也能解析', () => {
  assert.deepEqual(parseRetraction('```json\n{"retract":["签证"]}\n```'), ['签证']);
});
ok('缺 retract → 空', () => assert.deepEqual(parseRetraction('{"memories":[]}'), []));
ok('非法 JSON → 空', () => assert.deepEqual(parseRetraction('不是 json'), []));
ok('过滤空项', () => assert.deepEqual(parseRetraction('{"retract":["签证","", "   "]}'), ['签证']));

console.log('mergeRecalled（预取合并）');
ok('空 extra → 原样返回', () => {
  const base = recalled(['红线']);
  assert.equal(mergeRecalled(base, []), base);
});
ok('id 相同去重', () => {
  const base = recalled(['红线']);
  const merged = mergeRecalled(base, [base.constraint[0]]);
  assert.equal(merged.constraint.length, 1);
});
ok('新增按 kind 归桶', () => {
  const base = recalled([], [], [], [], []);
  const extra = [
    { id: 'f1', userId: 'u', characterId: 'c', kind: 'fact' as const, content: '事实', entityId: null, dimension: null, aspect: null, accessCount: 0, lastAccess: null, superseded: false, version: 1, createdAt: '' },
    { id: 'e1', userId: 'u', characterId: 'c', kind: 'episodic' as const, content: '事件', entityId: null, dimension: null, aspect: null, accessCount: 0, lastAccess: null, superseded: false, version: 1, createdAt: '' },
  ];
  const merged = mergeRecalled(base, extra);
  assert.equal(merged.fact.length, 1);
  assert.equal(merged.episodic.length, 1);
});

console.log('formatStateBlock（L1 状态）');
ok('含 [STATE] 与 mode', () => {
  const s = formatStateBlock({ mode: 'careful', stance: 'accompany', emotion: 'tender', mood: null, turnCount: 3 });
  assert.ok(s.startsWith('[STATE]'));
  assert.ok(s.includes('careful'));
});

console.log('formatHistory（L5 历史格式化）');
ok('空历史 → 空串', () => assert.equal(formatHistory([]), ''));
ok('摘要条目带标记', () => {
  const h = formatHistory([{ kind: 'summary', marker: '[HISTORY SUMMARY]', text: '前面聊了工作' }, turn('今天')]);
  assert.ok(h.includes('[HISTORY SUMMARY]'));
  assert.ok(h.includes('对方：今天'));
});
ok('只剩摘要 → 标成「更早对话摘要」', () => {
  const h = formatHistory([{ kind: 'summary', marker: '[HISTORY SUMMARY]', text: '前面聊了工作' }]);
  assert.ok(h.includes('更早对话摘要'));
  assert.ok(!h.includes('【最近对话】'));
});

console.log('pickLevel（压缩级别）');
ok('不超 → none', () => assert.equal(pickLevel(0.8), 'none'));
ok('1.0~1.5 → history', () => assert.equal(pickLevel(1.2), 'history'));
ok('1.5~2.0 → topic', () => assert.equal(pickLevel(1.7), 'topic'));
ok('>=2.0 → emergency', () => assert.equal(pickLevel(2.5), 'emergency'));

console.log('compressHistory（只压 L5）');
const ten = Array.from({ length: 10 }, (_, i) => turn(`这是第${i}句话`, i % 2 ? 'agent' : 'user'));
const fake = async (es: HistoryEntry[]) => `前${es.length}条摘要`;

ok('预算内 → 原样返回', async () => {
  const budget = estimateHistoryTokens(ten) + 10;
  const out = await compressHistory(ten, budget, fake);
  assert.equal(out.length, ten.length);
});
ok('history 级：保留最近 6 条 + [HISTORY SUMMARY]', async () => {
  const budget = Math.floor(estimateHistoryTokens(ten) * 0.98); // 略超 → history
  const out = await compressHistory(ten, budget, fake);
  assert.equal(out[0].kind, 'summary');
  assert.equal((out[0] as { marker: string }).marker, '[HISTORY SUMMARY]');
  assert.equal(out.filter((e) => e.kind === 'turn').length, 6);
});
ok('topic 级：保留最近 4 条 + [TOPIC SUMMARY]', async () => {
  const budget = Math.floor(estimateHistoryTokens(ten) / 1.7); // 1.7× → topic
  const out = await compressHistory(ten, budget, fake);
  assert.equal((out[0] as { marker: string }).marker, '[TOPIC SUMMARY]');
  assert.equal(out.filter((e) => e.kind === 'turn').length, 4);
});
ok('emergency 级：保留最近 2 条 + [EMERGENCY SUMMARY]', async () => {
  const budget = Math.floor(estimateHistoryTokens(ten) / 2.7); // 2.7× → emergency
  const out = await compressHistory(ten, budget, fake);
  assert.equal((out[0] as { marker: string }).marker, '[EMERGENCY SUMMARY]');
  assert.equal(out.filter((e) => e.kind === 'turn').length, 2);
});

console.log('historyToText');
ok('摘要 + 对话都能还原成文本', () => {
  const text = historyToText([{ kind: 'summary', marker: '[HISTORY SUMMARY]', text: 'x' }, turn('hi')]);
  assert.ok(text.includes('[HISTORY SUMMARY]'));
  assert.ok(text.includes('对方：hi'));
});

console.log('parseDetail（人物详情 frontmatter 解析）');
ok('标准 frontmatter → name/description/type/content', () => {
  const d = parseDetail('---\nname: 人，比事重要\ndescription: 触发于人、关系\n---\n正文内容', '认知');
  assert.equal(d.name, '人，比事重要');
  assert.equal(d.type, '认知');
  assert.equal(d.content, '正文内容');
});
ok('Windows \\r\\n 也能解析', () => {
  const d = parseDetail('---\r\nname: a\r\ndescription: b\r\n---\r\nbody', '偏好');
  assert.equal(d.name, 'a');
  assert.equal(d.content, 'body');
});
ok('无 frontmatter → 正文兜底', () => {
  const d = parseDetail('就一段话', '认知');
  assert.equal(d.content, '就一段话');
});

console.log('cosine（语义匹配）');
ok('相同向量 → 1', () => assert.ok(Math.abs(cosine([1, 2], [1, 2]) - 1) < 1e-9));
ok('正交 → 0', () => assert.ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9));

console.log('formatPersonaBlock（[PERSONA] 块）');
ok('空 → 空串', () => assert.equal(formatPersonaBlock([]), ''));
ok('命中详情 → [PERSONA] 块', () => {
  const b = formatPersonaBlock([{ name: 'x', description: 'd', type: '认知', content: '内容' } satisfies PersonaDetail]);
  assert.ok(b.startsWith('[PERSONA]'));
  assert.ok(b.includes('内容'));
});

console.log(`\n全部通过：${passed} 项`);
