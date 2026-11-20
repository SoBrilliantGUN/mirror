// 人设增补（self_added）纯逻辑冒烟测试：抽取解析 parseSelfAdded / 注入块 formatSelfAddedBlock。
// 运行：npm test
import { strict as assert } from 'node:assert';
import type { SelfAdded } from '@mirror/contracts';
import { parseSelfAdded } from '../src/brain/consolidate/selfAddTurn';
import { formatSelfAddedBlock } from '../src/brain/context';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const sa = (content: string, category = '喜好'): SelfAdded => ({
  id: '1', userId: 'u', personaName: 'c', category, content,
  mentionCount: 0, lastMentionedAt: null, active: true, createdAt: '',
});

console.log('parseSelfAdded（人设增补抽取解析）');
ok('合法 added', () => {
  assert.deepEqual(parseSelfAdded('{"added":{"category":"喜好","content":"喜欢爬山"}}'), { category: '喜好', content: '喜欢爬山' });
});
ok('added 为 null → null', () => {
  assert.equal(parseSelfAdded('{"added":null}'), null);
});
ok('缺 content → null', () => {
  assert.equal(parseSelfAdded('{"added":{"category":"喜好","content":""}}'), null);
});
ok('非法 JSON → null', () => {
  assert.equal(parseSelfAdded('not json'), null);
});
ok('markdown 代码块包裹也能解析', () => {
  assert.deepEqual(parseSelfAdded('```json\n{"added":{"category":"回忆","content":"高中打过替补"}}\n```'), { category: '回忆', content: '高中打过替补' });
});
ok('缺 category 回落「其它」', () => {
  assert.deepEqual(parseSelfAdded('{"added":{"content":"爱喝茶"}}'), { category: '其它', content: '爱喝茶' });
});

console.log('formatSelfAddedBlock（[SELF_ADDED] 注入块）');
ok('空列表 → 空串', () => {
  assert.equal(formatSelfAddedBlock([]), '');
});
ok('有内容 → 以 [SELF_ADDED] 开头、逐条列出', () => {
  const out = formatSelfAddedBlock([sa('喜欢爬山'), sa('偏爱苦味')]);
  assert.ok(out.startsWith('[SELF_ADDED]'));
  assert.ok(out.includes('喜欢爬山'));
  assert.ok(out.includes('偏爱苦味'));
});

console.log(`\nselfAdd 冒烟测试全部通过（${passed} 项）`);
