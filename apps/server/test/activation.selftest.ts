// 情节记忆软激活（computeActivation）纯逻辑冒烟测试：对齐 kima services/copilot.py 的遗忘公式。
// 运行：npm test
import { strict as assert } from 'node:assert';
import type { Memory, MemoryKind } from '@mirror/contracts';
import { computeActivation } from '../src/store/memory';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const NOW = new Date('2026-11-13T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const mem = (
  createdAt: string,
  accessCount = 0,
  lastAccess: string | null = null,
  kind: MemoryKind = 'episodic',
): Memory => ({
  id: '1', userId: 'u', characterId: 'c', kind, content: 'x',
  entityId: null, dimension: null, aspect: null,
  accessCount, lastAccess, superseded: false, version: 1, createdAt,
});

console.log('computeActivation（情节记忆软激活）');
ok('非 episodic 恒 1（约束/事实/偏好/人设强制在场，不走时间衰减）', () => {
  assert.equal(computeActivation(mem(daysAgo(100), 0, null, 'fact'), NOW), 1);
  assert.equal(computeActivation(mem(daysAgo(100), 0, null, 'profile'), NOW), 1);
  assert.equal(computeActivation(mem(daysAgo(100), 0, null, 'constraint'), NOW), 1);
});
ok('刚写入（age 0，无访问）→ 1', () => {
  assert.equal(computeActivation(mem(daysAgo(0)), NOW), 1);
});
ok('30 天无访问 → exp(-1)≈0.368，仍高于地板（软衰减，非硬切）', () => {
  assert.ok(Math.abs(computeActivation(mem(daysAgo(30)), NOW) - Math.exp(-1)) < 1e-6);
});
ok('90 天无访问 → 跌破地板 0.05（视为遗忘）', () => {
  assert.ok(computeActivation(mem(daysAgo(90)), NOW) < 0.05);
});
ok('90 天但被反复召回 → 频率增益续命', () => {
  assert.ok(computeActivation(mem(daysAgo(90), 20), NOW) > 0.05);
});
ok('90 天但近 7 天被召回 → 近期增益续命', () => {
  assert.ok(computeActivation(mem(daysAgo(90), 0, NOW.toISOString()), NOW) > 0.05);
});
ok('续命后不超过上限 1', () => {
  assert.equal(computeActivation(mem(daysAgo(0), 1000, NOW.toISOString()), NOW), 1);
});

console.log(`\nactivation 冒烟测试全部通过（${passed} 项）`);
