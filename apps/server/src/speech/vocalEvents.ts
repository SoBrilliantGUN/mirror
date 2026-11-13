import type { VocalizationEvent } from '@mirror/contracts';

// 聚合一轮内的哭/笑事件，用 confidence 加权判断「主导类型」。
// 动机：NLS 对哭/笑会互相误判（纯哭偶尔吐出 laugh、纯笑偶尔吐出 cry），
// 且单点置信度都偏低。只看单个事件会误判，累计加权后取主导才稳。
export type DominantVocal = 'cry' | 'laugh' | null;

export class VocalEventAggregator {
  private events: VocalizationEvent[] = [];
  private crySum = 0;
  private laughSum = 0;
  private firstAt = 0; // 本轮第一个有效事件的墙钟时间（Date.now()），用于「持续发声最大等待」

  constructor(private confThreshold = 0.3) {}

  add(ev: VocalizationEvent): void {
    const conf = ev.confidence ?? 1;
    if (conf < this.confThreshold) return; // 低置信度直接丢
    if (this.events.length === 0) this.firstAt = Date.now();
    this.events.push(ev);
    if (ev.type === 'cry') this.crySum += conf;
    else this.laughSum += conf;
  }

  // 原始事件列表（喂打分 prompt，保留每个事件的 conf 细节）
  get list(): VocalizationEvent[] {
    return this.events;
  }

  get hasAny(): boolean {
    return this.crySum > 0 || this.laughSum > 0;
  }

  get firstAtMs(): number {
    return this.firstAt;
  }

  // 主导类型：加权和较大一方，且差距超过 ratio（默认 15%）才判定；否则 null（不确定）。
  dominant(ratio = 1.15): DominantVocal {
    if (this.crySum <= 0 && this.laughSum <= 0) return null;
    if (this.crySum > this.laughSum * ratio) return 'cry';
    if (this.laughSum > this.crySum * ratio) return 'laugh';
    return null;
  }

  reset(): void {
    this.events = [];
    this.firstAt = 0;
    this.crySum = 0;
    this.laughSum = 0;
  }
}
