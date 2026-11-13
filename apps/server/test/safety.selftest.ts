// 纯逻辑冒烟测试：L4 安全红线——parseSafetyJson / keywordScan / resolveDependence / episode 去抖。
// 运行：npm test（或 tsx apps/server/test/safety.selftest.ts）
import { strict as assert } from 'node:assert';
import type { DeepSeek } from '../src/llm/deepseek';
import { SafetyGuard, parseSafetyJson, keywordScan, resolveDependence } from '../src/brain/safety';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const THRESHOLDS = { recentCalls7d: 5, currentCallMinutes: 40, lastGapMinutes: 30 };

console.log('parseSafetyJson（容错）');
ok('标准 JSON', () => {
  const p = parseSafetyJson('{"crisis_level":2,"dependence_level":1}');
  assert.equal(p.crisisLevel, 2);
  assert.equal(p.dependenceLevel, 1);
});
ok('包 markdown 代码块也能解析', () => {
  const p = parseSafetyJson('```json\n{"crisis_level":0,"dependence_level":0}\n```');
  assert.equal(p.crisisLevel, 0);
});
ok('带杂字也能抽到', () => {
  const p = parseSafetyJson('结果是 {"crisis_level":1,"dependence_level":2}，结束');
  assert.equal(p.crisisLevel, 1);
  assert.equal(p.dependenceLevel, 2);
});
ok('非法值回 0', () => {
  const p = parseSafetyJson('{"crisis_level":9,"dependence_level":-3}');
  assert.equal(p.crisisLevel, 0);
  assert.equal(p.dependenceLevel, 0);
});

console.log('keywordScan（兜底扫描）');
ok('强词 → 2', () => {
  assert.equal(keywordScan('我要自杀'), 2);
  assert.equal(keywordScan('我买了安眠药'), 2);
});
ok('弱词 → 1', () => {
  assert.equal(keywordScan('活着没意思'), 1);
  assert.equal(keywordScan('生无可恋'), 1);
});
ok('无 → 0（含反讽）', () => {
  assert.equal(keywordScan('我想死这歌了'), 0);
  assert.equal(keywordScan('今天好累'), 0);
});

console.log('resolveDependence（文本 + 行为叠加）');
const sig = (recentCalls7d: number, currentCallMinutes: number, lastGapMinutes: number | null) => ({ recentCalls7d, currentCallMinutes, lastGapMinutes });
ok('文本 level 0 → 恒 none', () => {
  assert.deepEqual(resolveDependence(0, sig(99, 99, 1), THRESHOLDS), { level: 0, action: 'none' });
});
ok('文本 ≥1 但行为不确认 → none（单句不升级）', () => {
  assert.deepEqual(resolveDependence(2, sig(1, 10, null), THRESHOLDS), { level: 0, action: 'none' });
});
ok('高频（≥5）确认 → boundary', () => {
  assert.deepEqual(resolveDependence(2, sig(5, 10, null), THRESHOLDS), { level: 2, action: 'boundary' });
});
ok('超长（≥40 分钟）确认 → boundary（文本 1 → level 1）', () => {
  assert.deepEqual(resolveDependence(1, sig(1, 40, null), THRESHOLDS), { level: 1, action: 'boundary' });
});
ok('刚挂又打（<30 分钟）确认 → boundary', () => {
  assert.deepEqual(resolveDependence(1, sig(1, 5, 20), THRESHOLDS), { level: 1, action: 'boundary' });
});
ok('无信号（undefined）→ none', () => {
  assert.deepEqual(resolveDependence(2, undefined, THRESHOLDS), { level: 0, action: 'none' });
});

console.log('SafetyGuard episode 去抖（假 LLM 抛错，走关键词兜底）');
const fakeLlm = { chat: async () => { throw new Error('fail'); } } as unknown as DeepSeek;
ok('首次命中 → refer；episode 内同档 → none；连续 2 轮 0 → 新 episode 再 refer', async () => {
  const g = new SafetyGuard({ llm: fakeLlm, model: 'x' });
  const a1 = await g.check('我要自杀');
  assert.deepEqual(a1.crisis, { level: 2, action: 'refer' });          // 首次：refer
  const a2 = await g.check('我要自杀');
  assert.deepEqual(a2.crisis, { level: 2, action: 'none' });           // episode 内同档：不重复
  const a3 = await g.check('我没事');
  assert.deepEqual(a3.crisis, { level: 0, action: 'none' });           // 平静第 1 轮
  const a4 = await g.check('我没事');
  assert.deepEqual(a4.crisis, { level: 0, action: 'none' });           // 平静第 2 轮 → episode 结束
  const a5 = await g.check('我要自杀');
  assert.deepEqual(a5.crisis, { level: 2, action: 'refer' });          // 新 episode：再 refer
});
ok('黄旗（level 1）恒不 refer（只进 careful 陪伴，不弹号）', async () => {
  const g = new SafetyGuard({ llm: fakeLlm, model: 'x' });
  assert.deepEqual((await g.check('活着没意思')).crisis, { level: 1, action: 'none' }); // 连续多轮：仍不转介
  assert.deepEqual((await g.check('活着没意思')).crisis, { level: 1, action: 'none' });
  assert.deepEqual((await g.check('我没事')).crisis, { level: 0, action: 'none' });
  assert.deepEqual((await g.check('活着没意思')).crisis, { level: 1, action: 'none' }); // 平静后重新出现：仍不转介
});
ok('红旗（level 2）立即 refer，不积累', async () => {
  const g = new SafetyGuard({ llm: fakeLlm, model: 'x' });
  const a1 = await g.check('我要自杀');
  assert.deepEqual(a1.crisis, { level: 2, action: 'refer' });
});
ok('黄旗转红旗（1 → 2）→ 立即 refer', async () => {
  const g = new SafetyGuard({ llm: fakeLlm, model: 'x' });
  const a1 = await g.check('活着没意思');
  assert.deepEqual(a1.crisis, { level: 1, action: 'none' });           // 黄旗第 1 轮，不转介
  const a2 = await g.check('我要自杀');
  assert.deepEqual(a2.crisis, { level: 2, action: 'refer' });          // 红旗立即
});
ok('空文本 → 直接 0，不进危机判定', async () => {
  const g = new SafetyGuard({ llm: fakeLlm, model: 'x' });
  const a = await g.check('   ');
  assert.deepEqual(a.crisis, { level: 0, action: 'none' });
  assert.deepEqual(a.dependence, { level: 0, action: 'none' });
});

console.log(`\n全部通过：${passed} 项`);
