// 纯逻辑冒烟测试：好奇心机制选话题（加权随机选维度 + 维度下随机选未回答话题）。
import { strict as assert } from 'node:assert';
import { pickCuriosityTopic, latestEventByDimension } from '../src/brain/curiosity';
import type { Memory } from '@mirror/contracts';

let passed = 0;
const tests: (() => Promise<void>)[] = [];
function ok(name: string, fn: () => void | Promise<void>) {
  tests.push(async () => { await fn(); passed++; console.log(`  ✓ ${name}`); });
}

const mem = (dimension: string, at?: string): Memory => ({
  id: dimension + (at ?? 'x'),
  userId: 'u',
  personaName: 'c',
  kind: 'episodic',
  content: 'x',
  entityId: null,
  dimension,
  aspect: null,
  anchor: at ? { kind: 'absolute', at } : undefined,
  accessCount: 0,
  lastAccess: null,
  superseded: false,
  version: 1,
  createdAt: '',
});

console.log('pickCuriosityTopic（加权随机选维度 + 随机选话题）');
ok('全 0 分也总能选出一个话题', async () => {
  const pick = await pickCuriosityTopic({ coverage: [], engagement: new Map(), latestEventAt: new Map(), askedIds: new Set(), rng: () => 0 });
  assert.ok(pick && pick.question.length > 0);
  assert.ok(pick.id.includes('_'));
});
ok('已回答的 id 被排除（固定 rng 下结果不同）', async () => {
  const rng = () => 0;
  const first = await pickCuriosityTopic({ coverage: [], engagement: new Map(), latestEventAt: new Map(), askedIds: new Set(), rng });
  const second = await pickCuriosityTopic({ coverage: [], engagement: new Map(), latestEventAt: new Map(), askedIds: new Set([first!.id]), rng });
  assert.ok(second && second.id !== first!.id);
});

console.log('latestEventByDimension（最新事件时间聚合）');
ok('取各维度最新绝对锚点', () => {
  const map = latestEventByDimension([mem('职业', '2026-11-20'), mem('职业', '2026-11-24'), mem('宠物', '2026-11-10')]);
  assert.equal(map.get('职业'), '2026-11-24');
  assert.equal(map.get('宠物'), '2026-11-10');
  assert.equal(map.get('旅行') ?? null, null);
});
ok('周期锚点/无维度被忽略', () => {
  const m: Memory = { ...mem('职业', '2026-11-20'), anchor: { kind: 'periodic', rule: { type: 'yearly', month: 11, day: 13 } } };
  const map = latestEventByDimension([m]);
  assert.equal(map.get('职业') ?? null, null);
});

async function run() {
  for (const t of tests) await t();
  console.log(`\n全部通过：${passed} 项`);
}
run();
