// 窗口化 sinc 重采样（升采样抗镜像、降采样抗混叠）。
// 线性插值升采样会在高频制造频谱镜像（听着发金属/发亮），故换 sinc。
// pcm 为 Int16Array（16-bit 有符号 PCM）。

const TAPS = 32; // 每侧 tap 数（共 65 个系数）

export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm;
  const ratio = to / from;
  const outLen = Math.round(pcm.length * ratio);
  const out = new Int16Array(outLen);

  // 截止频率取输入/输出奈奎斯特里较低者：升采样=输入奈奎斯特（去镜像），降采样=输出奈奎斯特（抗混叠）。
  const fcNorm = Math.min(from, to) / 2 / from;

  for (let i = 0; i < outLen; i++) {
    const t = i / ratio; // 输出 i 对应输入轴的位置（浮点）
    const lo = Math.max(0, Math.ceil(t - TAPS));
    const hi = Math.min(pcm.length - 1, Math.floor(t + TAPS));
    let acc = 0;
    let wsum = 0;
    for (let k = lo; k <= hi; k++) {
      const d = t - k;
      const sinc = d === 0 ? 2 * fcNorm : Math.sin(2 * Math.PI * fcNorm * d) / (Math.PI * d);
      const win = 0.54 + 0.46 * Math.cos((Math.PI * d) / TAPS); // Hamming 窗，[-TAPS, TAPS]
      const coef = sinc * win;
      acc += pcm[k] * coef;
      wsum += coef;
    }
    out[i] = wsum !== 0 ? Math.round(acc / wsum) : 0;
  }
  return out;
}
