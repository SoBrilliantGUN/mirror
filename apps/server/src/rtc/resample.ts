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

// 流式重采样器：实时链路逐 chunk 调用时，跨 chunk 携带 TAPS 个历史样本作为左/右上下文，
// 消除「每个 chunk 单独 resample」在边界处因截断核产生的不连续毛刺（听着发金属/咔哒）。
// 与 resample 的分工：resample 只适合整段一次性处理；实时流必须用这个。
// 首尾各 TAPS 个输出样本处于上下文不全的边界区，直接丢弃（已用相邻 chunk 的历史补齐）。
export function createStreamResampler(from: number, to: number): (chunk: Int16Array) => Int16Array {
  const ratio = to / from;
  // 前 TAPS 个是「已产出、只作左上下文」的样本；后 TAPS 个是「上一 chunk 尾部、待产出」的样本。
  let history = new Int16Array(2 * TAPS); // 初始 2*TAPS 个静音（音频开头本就接近静音）
  return (chunk: Int16Array): Int16Array => {
    if (chunk.length === 0) return new Int16Array(0);
    const combined = new Int16Array(history.length + chunk.length);
    combined.set(history);
    combined.set(chunk, history.length);
    // 可信任区间 = 左右各 TAPS 上下文齐全的部分；产出它，首尾边界各留 TAPS。
    const outStart = Math.round(TAPS * ratio);
    const outEnd = Math.round((TAPS + chunk.length) * ratio);
    const full = resample(combined, from, to);
    const out = full.slice(outStart, outEnd);
    history = combined.slice(combined.length - 2 * TAPS);
    return out;
  };
}
