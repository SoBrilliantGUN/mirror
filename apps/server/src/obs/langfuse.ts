// 可观测层（LangFuse 自托管）：把「一通电话」还原成可回溯的 session/trace/generation/event/score。
// 设计要点：
// - 无 LANGFUSE_PUBLIC/SECRET_KEY 时整体 no-op，热路径零开销、零崩溃。
// - 用 AsyncLocalStorage 把「当前 trace」传给内层 LLM/embedding 包装器，让所有调用自动挂到所属回合，
//   大脑模块（brain/*）与 llm/* 完全不用 import langfuse，保持纯净可单测。
// - 所有埋点 emit 都是 SDK 本地入队 + 后台异步 flush，且被 guard 包住——埋点失败绝不抛回热路径。
import { AsyncLocalStorage } from 'node:async_hooks';
import { Langfuse, type LangfuseTraceClient } from 'langfuse';
import type { LlmClient, ChatMessage, Tool, ChatOptions, StreamEvent } from '../llm/client';
import type { Embedder } from '../llm/embedding';

export type ObsSession = { sessionId: string; userId: string; personaName: string };

export type EventLevel = 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';

export type TraceOpts = { metadata?: Record<string, unknown>; input?: unknown };

export type Obs = {
  enabled: boolean;
  setSession(s: ObsSession | null): void;
  // 开一个 trace 并在其 ALS 上下文里跑 fn（内层 generation/span/event/score 自动挂到它）。
  trace<T>(name: string, opts: TraceOpts | undefined, fn: () => Promise<T>): Promise<T>;
  // 当前 trace 下记一个 span（非 LLM 环节），自动计时，fn 的返回值作为 output。
  span<T>(name: string, fn: () => Promise<T>, input?: unknown): Promise<T>;
  // 当前 trace 下记一个离散事件。
  event(name: string, input?: unknown, level?: EventLevel): void;
  // 当前 trace 下记一个数值指标。
  score(name: string, value: number): void;
  // 当前 trace 补写 output（回合最终回复文本，方便 Session 时间线扫读）。
  setOutput(output: unknown): void;
  currentTraceId(): string | null;
  wrapLlm(inner: LlmClient, label: string): LlmClient;
  wrapEmbedder(inner: Embedder, label: string, model?: string): Embedder;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
};

type AlsStore = { trace: LangfuseTraceClient };

// ---------------------------------------------------------------------------
// 真实实现
// ---------------------------------------------------------------------------
function realObs(cfg: { publicKey: string; secretKey: string; baseUrl: string }): Obs {
  const langfuse = new Langfuse({ publicKey: cfg.publicKey, secretKey: cfg.secretKey, baseUrl: cfg.baseUrl });
  const als = new AsyncLocalStorage<AlsStore>();
  let session: ObsSession | null = null;
  let warnedNoTrace = false;
  let warnedEmit = false;

  const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const warnNoTrace = () => {
    if (warnedNoTrace) return;
    warnedNoTrace = true;
    console.warn('[obs] 检测到无活跃 trace 的 LLM/embedding 调用被跳过埋点（可能漏包 obs.trace）');
  };

  // 埋点 emit 永不抛错：失败降级跳过（只告警一次），绝不拖垮实时通话。
  const guard = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (e) {
      if (!warnedEmit) {
        warnedEmit = true;
        console.warn('[obs] 埋点失败，降级跳过：', err(e));
      }
      return fallback;
    }
  };

  const obs = {
    enabled: true as const,

    setSession(s: ObsSession | null) {
      session = s;
    },

    async trace<T>(name: string, opts: TraceOpts | undefined, fn: () => Promise<T>): Promise<T> {
      let trace: LangfuseTraceClient | null = null;
      try {
        trace = langfuse.trace({
          name,
          input: opts?.input,
          metadata: { ...(opts?.metadata ?? {}), personaName: session?.personaName ?? null },
          sessionId: session?.sessionId ?? null,
          userId: session?.userId ?? null,
          tags: session ? [session.personaName] : undefined,
        });
      } catch (e) {
        console.warn('[obs] 创建 trace 失败，本轮不埋点：', err(e));
        return fn();
      }
      return als.run({ trace }, fn);
    },

    async span<T>(name: string, fn: () => Promise<T>, input?: unknown): Promise<T> {
      const store = als.getStore();
      if (!store) return fn();
      const s: any = guard(() => store.trace.span({ name, input }), null);
      try {
        const out = await fn();
        if (s) guard(() => { s.end({ output: out }); }, undefined);
        return out;
      } catch (e) {
        if (s) guard(() => { s.end({ level: 'ERROR', statusMessage: err(e) }); }, undefined);
        throw e;
      }
    },

    event(name: string, input?: unknown, level: EventLevel = 'DEFAULT') {
      const store = als.getStore();
      if (!store) return;
      guard(() => { store.trace.event({ name, input, level }); }, undefined);
    },

    score(name: string, value: number) {
      const store = als.getStore();
      if (!store) return;
      guard(() => { store.trace.score({ name, value }); }, undefined);
    },

    setOutput(output: unknown) {
      const store = als.getStore();
      if (!store) return;
      guard(() => { store.trace.update({ output }); }, undefined);
    },

    currentTraceId(): string | null {
      return als.getStore()?.trace.id ?? null;
    },

    wrapLlm(inner: LlmClient, label: string): LlmClient {
      return {
        chat: (messages: ChatMessage[], opts: ChatOptions) =>
          gen('chat', label, opts.model, messages, () => inner.chat(messages, opts)),
        chatWithTools: (messages: ChatMessage[], tools: Tool[], opts: ChatOptions) =>
          gen('chatWithTools', label, opts.model, messages, () => inner.chatWithTools(messages, tools, opts)),
        stream: (messages: ChatMessage[], opts: ChatOptions) =>
          // async generator 的 body 要等首次迭代才执行，所以在这里（调用点）就把 store 抓下来传进去。
          genStream(als.getStore() ?? null, label, opts.model, messages, inner.stream(messages, opts)),
        streamWithTools: (messages: ChatMessage[], tools: Tool[], opts: ChatOptions) =>
          genStreamTools(als.getStore() ?? null, label, opts.model, messages, inner.streamWithTools(messages, tools, opts)),
      } as unknown as LlmClient;
    },

    wrapEmbedder(inner: Embedder, label: string, model?: string): Embedder {
      return {
        embed: (texts: string[]) => genEmbed(label, model, texts, () => inner.embed(texts)),
      };
    },

    async flush() {
      try {
        await langfuse.flushAsync();
      } catch (e) {
        console.warn('[obs] flush 失败：', err(e));
      }
    },

    async shutdown() {
      try {
        await langfuse.shutdownAsync();
      } catch (e) {
        console.warn('[obs] shutdown 失败：', err(e));
      }
    },
  };

  // 非流式 LLM 调用：开 generation，跑完补 output / error。
  async function gen<T>(name: string, label: string, model: string | undefined, input: unknown, run: () => Promise<T>): Promise<T> {
    const store = als.getStore();
    if (!store) {
      warnNoTrace();
      return run();
    }
    const g: any = guard(() => store.trace.generation({ name, model, input, metadata: { label } }), null);
    try {
      const out = await run();
      if (g) guard(() => { g.end({ output: out }); }, undefined);
      return out;
    } catch (e) {
      if (g) guard(() => { g.end({ level: 'ERROR', statusMessage: err(e) }); }, undefined);
      throw e;
    }
  }

  // 流式 LLM 调用：边 yield 边累积，finally 里补全文 output（打断也留部分）。
  async function* genStream(store: AlsStore | null, label: string, model: string | undefined, input: unknown, src: AsyncGenerator<string>): AsyncGenerator<string> {
    if (!store) {
      warnNoTrace();
      yield* src;
      return;
    }
    const g: any = guard(() => store.trace.generation({ name: 'stream', model, input, metadata: { label } }), null);
    let full = '';
    let error: unknown = null;
    try {
      for await (const delta of src) {
        full += delta;
        yield delta;
      }
    } catch (e) {
      error = e;
      throw e;
    } finally {
      if (g) {
        guard(() => {
          if (error) g.end({ output: full, level: 'ERROR', statusMessage: err(error) });
          else g.end({ output: full });
        }, undefined);
      }
    }
  }

  // 流式工具调用：边 yield 边累积文本，finally 补全文 output（有工具调用时附上调用数）。
  async function* genStreamTools(store: AlsStore | null, label: string, model: string | undefined, input: unknown, src: AsyncGenerator<StreamEvent>): AsyncGenerator<StreamEvent> {
    if (!store) {
      warnNoTrace();
      yield* src;
      return;
    }
    const g: any = guard(() => store.trace.generation({ name: 'stream', model, input, metadata: { label } }), null);
    let text = '';
    let toolCalls = 0;
    let error: unknown = null;
    try {
      for await (const ev of src) {
        if (ev.type === 'text') text += ev.text;
        else toolCalls += ev.calls.length;
        yield ev;
      }
    } catch (e) {
      error = e;
      throw e;
    } finally {
      if (g) {
        guard(() => {
          const output = toolCalls > 0 ? { text, toolCalls } : text;
          if (error) g.end({ output, level: 'ERROR', statusMessage: err(error) });
          else g.end({ output });
        }, undefined);
      }
    }
  }

  // embedding 调用：output 只留条数/维度，不存全量向量。
  async function genEmbed(label: string, model: string | undefined, input: unknown, run: () => Promise<number[][]>): Promise<number[][]> {
    const store = als.getStore();
    if (!store) {
      warnNoTrace();
      return run();
    }
    const g: any = guard(() => store.trace.generation({ name: 'embed', model, input, metadata: { label } }), null);
    try {
      const vecs = await run();
      if (g) guard(() => { g.end({ output: { count: vecs.length, dim: vecs[0]?.length ?? 0 } }); }, undefined);
      return vecs;
    } catch (e) {
      if (g) guard(() => { g.end({ level: 'ERROR', statusMessage: err(e) }); }, undefined);
      throw e;
    }
  }

  return obs as Obs;
}

// ---------------------------------------------------------------------------
// no-op 实现（无 key 时）
// ---------------------------------------------------------------------------
function noopObs(): Obs {
  return {
    enabled: false,
    setSession() {},
    trace: (_name, _opts, fn) => fn(),
    span: (_name, fn) => fn(),
    event() {},
    score() {},
    setOutput() {},
    currentTraceId: () => null,
    wrapLlm: (inner) => inner,
    wrapEmbedder: (inner) => inner,
    flush: async () => {},
    shutdown: async () => {},
  };
}

export function createObs(cfg: { publicKey: string; secretKey: string; baseUrl: string }): Obs {
  if (!cfg.publicKey || !cfg.secretKey) {
    return noopObs();
  }
  return realObs(cfg);
}
