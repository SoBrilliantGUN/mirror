// 纯逻辑冒烟测试：normalizeUserName（拼音指纹纠正用户名同音字）。
import { strict as assert } from 'node:assert';
import { normalizeUserName } from '../src/speech/nameNormalizer';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('normalizeUserName');
ok('「章鱼哥」→「张渔歌」', () => {
  assert.equal(normalizeUserName('请叫我章鱼哥', '张渔歌'), '请叫我张渔歌');
});
ok('「章宇哥」→「张渔歌」（声调不同也替换）', () => {
  assert.equal(normalizeUserName('你好，章宇哥', '张渔歌'), '你好，张渔歌');
});
ok('正确名字不重复替换', () => {
  assert.equal(normalizeUserName('我是张渔歌', '张渔歌'), '我是张渔歌');
});
ok('不含名字时原样返回', () => {
  assert.equal(normalizeUserName('今天天气不错', '张渔歌'), '今天天气不错');
});
ok('空名字 / 空文本不报错', () => {
  assert.equal(normalizeUserName('你好', ''), '你好');
  assert.equal(normalizeUserName('', '张渔歌'), '');
});
ok('只匹配全名，不匹配去掉姓氏的「名」（渔歌）', () => {
  assert.equal(normalizeUserName('这首歌是渔歌', '张渔歌'), '这首歌是渔歌');
});

console.log(`\n全部通过：${passed} 项`);
