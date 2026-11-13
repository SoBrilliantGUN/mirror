// 纯逻辑冒烟测试：parseBochaResult / pickFiller。
// 运行：npm test
import { strict as assert } from 'node:assert';
import { parseBochaResult } from '../src/search/bocha';
import { pickFiller } from '../src/brain/search';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('parseBochaResult');
ok('正常解析 data.webPages.value[]', () => {
  const r = parseBochaResult({ data: { webPages: { value: [{ name: '标题', url: 'https://x', snippet: '摘要' }] } } });
  assert.equal(r.length, 1);
  assert.equal(r[0].title, '标题');
  assert.equal(r[0].url, 'https://x');
  assert.equal(r[0].snippet, '摘要');
});
ok('缺 snippet 时 summary 回退', () => {
  const r = parseBochaResult({ data: { webPages: { value: [{ name: '标题', url: 'u', summary: '回退摘要' }] } } });
  assert.equal(r[0].snippet, '回退摘要');
});
ok('title 用 title 字段回退', () => {
  const r = parseBochaResult({ data: { webPages: { value: [{ title: 'T', url: 'u', snippet: 's' }] } } });
  assert.equal(r[0].title, 'T');
});
ok('空 / 非数组 → 空数组', () => {
  assert.equal(parseBochaResult(undefined).length, 0);
  assert.equal(parseBochaResult({}).length, 0);
  assert.equal(parseBochaResult({ data: { webPages: { value: 'not-array' } } }).length, 0);
});
ok('title 和 snippet 都空 → 过滤掉', () => {
  const r = parseBochaResult({ data: { webPages: { value: [{ name: '', url: '', snippet: '' }] } } });
  assert.equal(r.length, 0);
});

console.log('pickFiller');
ok('返回非空短语', () => assert.ok(pickFiller().length > 0));

console.log(`\n全部通过：${passed} 项`);
