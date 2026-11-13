// 纯逻辑冒烟测试：buildCuriosityHint（好奇心缺口线索的降噪）。
// 运行：npm test
import { strict as assert } from 'node:assert';
import { buildCuriosityHint, CURIOSITY_DIMENSIONS } from '../src/brain/ontology';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('buildCuriosityHint');
ok('空 coverage → 精简提示（不 dump 维度清单）', () => {
  const h = buildCuriosityHint([]);
  assert.ok(h && h.includes('你还不了解对方'));
  assert.ok(!h.includes('原生家庭'));
});
ok('全维度全子槽已覆盖 → undefined', () => {
  const full = CURIOSITY_DIMENSIONS.flatMap((d) => d.aspects.map((a) => ({ dimension: d.key, aspect: a, count: 1 })));
  assert.equal(buildCuriosityHint(full), undefined);
});
ok('部分覆盖 → 边级延伸 + 空维度截断', () => {
  const partial = [
    { dimension: '职业', aspect: '当前工作', count: 1 },
    { dimension: '教育', aspect: '学校', count: 1 },
    { dimension: '关系', aspect: '伴侣', count: 1 },
    { dimension: '爱好', aspect: '兴趣爱好', count: 1 },
    { dimension: '旅行', aspect: '去过的地方', count: 1 },
  ];
  const h = buildCuriosityHint(partial)!;
  assert.ok(h.includes('你提到了职业，但还不知道')); // 边级延伸（具体缺口）
  assert.ok(h.includes('还不太了解') && h.includes('等')); // 空维度截断
  assert.ok(!h.includes('健康')); // 第 5 个空维度被截掉（最多列 3 个）
});

console.log(`\n全部通过：${passed} 项`);
