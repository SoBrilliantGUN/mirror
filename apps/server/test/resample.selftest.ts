// 窗口化 sinc 重采样冒烟测试：DC 增益 / 升采样保真 / 降采样抗混叠。
// 运行：npm test
import { strict as assert } from 'node:assert';
import { resample } from '../src/rtc/resample';

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function sine(freq: number, sr: number, n: number, amp = 12000): Int16Array {
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * amp);
  return a;
}

console.log('resample（窗口化 sinc）');
ok('同采样率 → 原样返回', () => {
  const src = new Int16Array([1, 2, 3, 4]);
  assert.equal(resample(src, 24000, 24000), src);
});

ok('DC 常数不放大不缩小', () => {
  const src = new Int16Array(480).fill(1000); // 24kHz 下 20ms
  const out = resample(src, 24000, 48000);
  assert.equal(out.length, 960);
  for (let i = 0; i < out.length; i++) {
    assert.ok(Math.abs(out[i] - 1000) <= 1, `期望≈1000，实得 ${out[i]}`);
  }
});

ok('升采样保留低频正弦', () => {
  const out = resample(sine(1000, 24000, 480), 24000, 48000);
  let peak = 0;
  for (let i = 100; i < out.length - 100; i++) peak = Math.max(peak, Math.abs(out[i]));
  assert.ok(peak > 11000, `期望峰值≈12000，实得 ${peak}`);
});

ok('降采样滤掉超奈奎斯特分量', () => {
  // 48kHz 下 15kHz 正弦，降到 16kHz（奈奎斯特 8kHz）应被滤掉
  const out = resample(sine(15000, 48000, 960), 48000, 16000);
  let peak = 0;
  for (let i = 100; i < out.length - 100; i++) peak = Math.max(peak, Math.abs(out[i]));
  assert.ok(peak < 3000, `期望峰值≪12000（被抗混叠滤掉），实得 ${peak}`);
});

console.log(`\n全部通过：${passed} 项`);
