// 代际中止门（generation gate）：一通电话里「哪次生成还作数」。
// 之前用一个散落的 currentGeneration 计数器 + 一个 currentAbort 手动锁，靠约定俗成维护；
// 收敛成具名对象：
//   begin()      —— 开一代：返回 { gen, signal }，signal 是这一代的 AbortSignal（喂给 TTS/LLM 流式）。
//   isCurrent()  —— 判断某个 gen 是否仍是当前代（跨 await 后写回前先验一次，作废就别继续）。
//   invalidate() —— 作废当前代并中止其网络请求（打断 / 挂断 / 新输入到来时调用）。
export class GenerationGate {
  private gen = 0;
  private abort: AbortController | null = null;

  begin(): { gen: number; signal: AbortSignal } {
    this.gen += 1;
    this.abort = new AbortController();
    return { gen: this.gen, signal: this.abort.signal };
  }

  isCurrent(gen: number): boolean {
    return gen === this.gen;
  }

  invalidate(): void {
    this.gen += 1;
    this.abort?.abort();
    this.abort = null;
  }
}
