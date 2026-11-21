// 纯逻辑冒烟测试：地板相位状态机 reducePhase + nudgeDelayMs。
// 这是「拆状态机」的产物——以前 turn-taking 的打断/宽限/重答只能靠 mock RTC 驱动真实会话验证，
// 现在核心决策是纯函数，直接表测。
import { strict as assert } from 'node:assert';
import { reducePhase, nudgeDelayMs } from '../src/conversationFlow';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('reducePhase（地板相位迁移）');
ok('beginTurn → thinking', () => {
  assert.equal(reducePhase('idle', { type: 'beginTurn' }).phase, 'thinking');
});
ok('markAudible → speaking', () => {
  assert.equal(reducePhase('thinking', { type: 'markAudible' }).phase, 'speaking');
});
ok('rtc 打断 → interruptGrace + 武装宽限', () => {
  const r = reducePhase('speaking', { type: 'interrupt', source: 'rtc' });
  assert.equal(r.phase, 'interruptGrace');
  assert.deepEqual(r.effects, [{ kind: 'armGraceTimer' }]);
});
ok('宽限到点 → idle + 真打断', () => {
  const r = reducePhase('interruptGrace', { type: 'graceElapsed' });
  assert.equal(r.phase, 'idle');
  assert.deepEqual(r.effects, [{ kind: 'doBargeIn' }]);
});
ok('asr 打断（用户真说话）→ 直接 idle + 真打断', () => {
  const r = reducePhase('speaking', { type: 'interrupt', source: 'asr' });
  assert.equal(r.phase, 'idle');
  assert.deepEqual(r.effects, [{ kind: 'doBargeIn' }]);
});
ok('playbackEnd → idle', () => {
  assert.equal(reducePhase('speaking', { type: 'playbackEnd' }).phase, 'idle');
});
ok('stopSpeaking（挂断/强停）→ idle', () => {
  assert.equal(reducePhase('thinking', { type: 'stopSpeaking' }).phase, 'idle');
});
ok('非宽限态收到 graceElapsed 是 no-op（不误打断）', () => {
  const r = reducePhase('idle', { type: 'graceElapsed' });
  assert.equal(r.phase, 'idle');
  assert.deepEqual(r.effects, []);
});

console.log('nudgeDelayMs（情绪动态计时）');
const mood = (valence: number, arousal: number, dominance: number) => ({ valence, arousal, dominance });
ok('中性基线 10s', () => {
  assert.equal(nudgeDelayMs(mood(0, 0, 0), false), 10000);
});
ok('轻松 → 早接话（< 10s）', () => {
  assert.ok(nudgeDelayMs(mood(1, 0, 0), false) < 10000);
});
ok('低落 → 多给空间（> 10s）', () => {
  assert.ok(nudgeDelayMs(mood(-1, 0, 0), false) > 10000);
});
ok('逞强（incongruence）→ 再 +4s', () => {
  assert.ok(nudgeDelayMs(mood(0, 0, 0), true) > nudgeDelayMs(mood(0, 0, 0), false));
});

console.log(`\n全部通过：${passed} 项`);
