// 纯逻辑冒烟测试：parseFarewell（道别模型输出的 JSON 解析，容错）。
// 运行：npm test
import { strict as assert } from 'node:assert';
import { parseFarewell } from '../src/brain/farewell';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('parseFarewell（容错）');
ok('标准 true', () => assert.equal(parseFarewell('{"farewell":true}'), true));
ok('标准 false', () => assert.equal(parseFarewell('{"farewell":false}'), false));
ok('包 markdown 代码块也能解析', () => assert.equal(parseFarewell('```json\n{"farewell":true}\n```'), true));
ok('带杂字也能抽到', () => assert.equal(parseFarewell('结果是 {"farewell":true}，结束'), true));
ok('字符串 "true" 也算', () => assert.equal(parseFarewell('{"farewell":"true"}'), true));
ok('字符串 "false" 不算', () => assert.equal(parseFarewell('{"farewell":"false"}'), false));
ok('非法 JSON → false', () => assert.equal(parseFarewell('不是 json'), false));
ok('缺失字段 → false', () => assert.equal(parseFarewell('{"foo":1}'), false));
ok('空字符串 → false', () => assert.equal(parseFarewell(''), false));

console.log(`\n全部通过：${passed} 项`);
