// 通用 OpenAI 兼容 LLM 客户端。零依赖，Node 内置 fetch。
// 类名是 LlmClient 而不是 DeepSeek：这个类不只打 DeepSeek——安全红线打的是百炼 qwen、
// 打分/生成走 DeepSeek，名字跟着某一个供应商会误导（见 server.ts 里三处 new LlmClient 的不同端点）。

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  // assistant 带 tool_calls 时：content 为 null，tool_calls 列出要调的工具。
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  // tool 角色：回填对应 tool_call 的 id。
  tool_call_id?: string;
};

export type Tool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ChatOptions = {
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number; // 覆盖默认 20s 超时（如安全检测用更短的，快速失败走兜底）
};

// 工具调用归一化结果：content 是纯文本（可能为空），toolCalls 是要执行的工具。
export type ToolCall = { id: string; name: string; arguments: string };
export type ChatWithToolsResult = { content: string; toolCalls: ToolCall[] };

// 流式工具调用事件：text = 普通文本增量（逐个 yield）；tool_calls = 流结束时汇总的工具调用（有则必有，且通常无文本）。
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[] };

// 把 SSE 流按行切，逐条 yield 出 "data: {...}" 的 payload；[DONE] 与心跳行被过滤掉。
// stream / streamWithTools 共用，消掉两处重复的 buf + 按行切分 + JSON.parse 外壳。
async function* readSsePayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? ''; // 最后一行可能不完整，留下次拼
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      yield payload;
    }
  }
}

export class LlmClient {
  constructor(private readonly cfg: { apiKey: string; baseUrl: string }) {}

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.cfg.apiKey}`,
    };
  }

  // POST 到 /chat/completions，非 2xx 抛错。四个公开方法共用，消掉重复的 fetch + 状态检查。
  private async post(body: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`LLM 请求失败: ${res.status} ${await res.text()}`);
    }
    return res;
  }

  // 非流式：打分等小输出用。
  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
    const res = await this.post(
      {
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens,
        stream: false,
      },
      opts.timeoutMs ?? 20000, // 打分/决策卡住不再无限等
    );
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0].message.content;
  }

  // 工具调用（非流式）：ReAct 循环里让模型决定调 recall_memory / write_memory。
  // 返回纯文本 + 归一化的 tool_calls（无工具调用时 toolCalls 为空数组）。
  async chatWithTools(messages: ChatMessage[], tools: Tool[], opts: ChatOptions): Promise<ChatWithToolsResult> {
    const res = await this.post(
      {
        model: opts.model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens,
        stream: false,
      },
      20000,
    );
    const data = (await res.json()) as {
      choices: { message: {
        content?: string | null;
        tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
      } }[];
    };
    const message = data.choices[0].message;
    const toolCalls = (message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
    return { content: message.content ?? '', toolCalls };
  }

  // 流式工具调用：文本增量逐个 yield（type:'text'），流结束时若有工具调用 yield 一次（type:'tool_calls'）。
  // 模型决定要调工具时通常只吐 tool_calls、不吐文本；决定直接答时只吐文本。两态互斥，调用方按事件类型分流。
  async *streamWithTools(messages: ChatMessage[], tools: Tool[], opts: ChatOptions): AsyncGenerator<StreamEvent> {
    const res = await this.post(
      {
        model: opts.model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens,
        stream: true,
      },
      120000,
    );
    if (!res.body) {
      throw new Error('LLM 流式响应无 body');
    }

    // 按 index 累积 tool_calls（arguments 分片到达，id/name 只在首片）。
    const acc = new Map<number, { id: string; name: string; args: string }>();

    for await (const payload of readSsePayloads(res.body)) {
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: {
            content?: string | null;
            tool_calls?: Array<{ index?: number; id?: string; type?: 'function'; function?: { name?: string; arguments?: string } }>;
          } }[];
        };
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) yield { type: 'text', text: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = acc.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          acc.set(idx, cur);
        }
      } catch {
        // 忽略无法解析的行（心跳/keep-alive）
      }
    }

    if (acc.size > 0) {
      yield {
        type: 'tool_calls',
        calls: [...acc.values()].map((c) => ({ id: c.id, name: c.name, arguments: c.args })),
      };
    }
  }

  // 流式：生成用。逐段 yield 增量文本。
  async *stream(messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<string> {
    const res = await this.post(
      {
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.7,
        max_tokens: opts.maxTokens,
        stream: true,
      },
      120000, // 流式生成给足时间
    );
    if (!res.body) {
      throw new Error('LLM 流式响应无 body');
    }

    for await (const payload of readSsePayloads(res.body)) {
      try {
        const json = JSON.parse(payload) as {
          choices: { delta: { content?: string } }[];
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // 忽略无法解析的行（心跳/keep-alive）
      }
    }
  }
}
