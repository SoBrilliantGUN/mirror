// HTTP 路由：通讯录 / 记忆库 / 聊天导出 / 健康检查，外加把 /rtc/offer 委托给会话编排（session.handleOffer）。
// 纯接线、无业务状态；RTC 编排那一大坨在 session.ts，这里只做「解析请求 → 调 store → 写响应」。
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MemoryKind, MemoryStore } from '@mirror/contracts';

export type OfferBody = { sdp: string; name?: string; lang?: 'zh' | 'en'; englishMode?: 'immersion' | 'coach' };
export type OfferResult = { sdp: string } | { error: string; status: number };

export type RouterDeps = {
  contacts: { list(): Promise<string[]>; add(name: string): Promise<string[]>; remove(name: string): Promise<string[]> };
  memory: MemoryStore;
  transcript: { list(personaName: string, userId: string, opts: { since?: string; limit?: number }): Promise<unknown[]> };
  dreamRuns: { recent(personaName: string, userId: string, limit?: number): Promise<unknown[]> };
  userId: string;
  defaultPersona: () => string; // 当前 persona.name（无 ?persona 时的回退）
  onRtcOffer: (body: OfferBody) => Promise<OfferResult>;
};

export function createRouter(deps: RouterDeps): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(req, res);
  };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 健康检查：前端轮询它判断后端是否还活着（挂了就中断通话 + 报错）
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // 通讯录：持久化已添加的伙伴（Postgres，见 store/contacts.ts + db.ts）
    if (req.method === 'GET' && req.url === '/contacts') {
      try {
        sendJson(res, 200, { names: await deps.contacts.list() });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/contacts') {
      try {
        const { name } = await readJson<{ name: string }>(req);
        if (!name || typeof name !== 'string') {
          sendJson(res, 400, { error: 'name 必填' });
          return;
        }
        sendJson(res, 200, { names: await deps.contacts.add(name) });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }
    if (req.method === 'DELETE' && req.url?.startsWith('/contacts/')) {
      try {
        const name = decodeURIComponent(req.url.slice('/contacts/'.length));
        sendJson(res, 200, { names: await deps.contacts.remove(name) });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }

    // 笔记本 / 记忆库：跨型列出某伙伴的未归档记忆（?persona=姓名&since=ISO&kind=类型）。
    if (req.method === 'GET' && req.url?.startsWith('/memories')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        const personaName = u.searchParams.get('persona') ?? deps.defaultPersona();
        const since = u.searchParams.get('since') ?? undefined;
        const kindParam = u.searchParams.get('kind');
        const kind = kindParam ? (kindParam as MemoryKind) : undefined;
        sendJson(res, 200, { memories: await deps.memory.listAll(personaName, deps.userId, { kind, since }) });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }
    // 笔记本编辑：PATCH /memories/:id?persona=姓名，body { content?, kind? }。
    if (req.method === 'PATCH' && req.url?.startsWith('/memories/')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        const id = u.pathname.slice('/memories/'.length);
        const personaName = u.searchParams.get('persona') ?? deps.defaultPersona();
        const body = await readJson<{ content?: string; kind?: MemoryKind }>(req);
        const m = await deps.memory.update(personaName, deps.userId, id, body);
        if (!m) {
          sendJson(res, 404, { error: '记忆不存在' });
          return;
        }
        sendJson(res, 200, { memory: m });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }
    // 笔记本删除：DELETE /memories/:id?persona=姓名（软删除 superseded）。
    if (req.method === 'DELETE' && req.url?.startsWith('/memories/')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        const id = u.pathname.slice('/memories/'.length);
        const personaName = u.searchParams.get('persona') ?? deps.defaultPersona();
        sendJson(res, 200, { removed: await deps.memory.remove(personaName, deps.userId, id) });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }

    // 做梦记录：最近 N 次巩固的运行计数（前端展示「做梦在干什么」）。
    if (req.method === 'GET' && req.url?.startsWith('/dream')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        const personaName = u.searchParams.get('persona') ?? deps.defaultPersona();
        const limitParam = u.searchParams.get('limit');
        const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 20) : 20;
        sendJson(res, 200, { runs: await deps.dreamRuns.recent(personaName, deps.userId, limit) });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }

    // 聊天记录导出：结构化 JSON（对话正文 + 元数据），供后续分析/优化。
    if (req.method === 'GET' && req.url?.startsWith('/export/chat')) {
      try {
        const u = new URL(req.url, 'http://localhost');
        const personaName = u.searchParams.get('persona') ?? deps.defaultPersona();
        const since = u.searchParams.get('since') ?? undefined;
        const limitParam = u.searchParams.get('limit');
        const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || 2000) : undefined;
        const turns = await deps.transcript.list(personaName, deps.userId, { since, limit });
        sendJson(res, 200, { personaName, exportedAt: new Date().toISOString(), count: turns.length, turns });
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/rtc/offer') {
      try {
        const body = await readJson<OfferBody>(req);
        const result = await deps.onRtcOffer(body);
        if ('error' in result) {
          sendJson(res, result.status, { error: result.error });
        } else {
          sendJson(res, 200, { sdp: result.sdp });
        }
      } catch (e) {
        sendJson(res, 500, { error: String(e) });
      }
      return;
    }

    res.writeHead(404);
    res.end('not found');
  }
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data) as T);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
