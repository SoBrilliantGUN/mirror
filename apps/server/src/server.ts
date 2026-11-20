// 实时通话服务入口：装配配置/存储/LLM → 起 HTTP（router）+ 单会话编排（CallSession）→ 后台做梦巩固。
import { createServer } from 'node:http';
import { loadConfig, loadDotEnv } from './config';
import { DeepSeek } from './llm/deepseek';
import { createEmbedder } from './llm/embedding';
import { PERSONAS } from './persona';
import { createTimeAware } from './brain/timeAware';
import { shanghaiParts } from './brain/timezone';
import { loadHolidayMap } from './brain/holiday';
import { createSummarizer } from './brain/compress';
import { dreamOnMemory } from './brain/consolidate/dream';
import { createContactsStore } from './store/contacts';
import { createMemoryStore } from './store/memory';
import { createAskedQuestionsStore } from './store/askedQuestions';
import { createConversationSummariesStore } from './store/conversationSummaries';
import { createSelfAddedStore } from './store/selfAdded';
import { createGoalsStore } from './store/goals';
import { createPool, ensureSchema } from './store/db';
import { createSessionsStore } from './store/sessions';
import { createTranscriptStore } from './store/transcript';
import { createObs } from './obs/langfuse';
import { createRouter } from './router';
import { CallSession } from './session';

export async function main() {
  // 桌面版由 Electron 主进程注入 env（不读 .env）；`npm start` 仍读 .env。
  if (process.env.MIRROR_SKIP_DOTENV !== '1') loadDotEnv();
  const cfg = loadConfig();
  console.log(cfg.bochaApiKey ? '[search] 联网搜索已启用（BOCHA_API_KEY 已配）' : '[search] 联网搜索关闭（未配 BOCHA_API_KEY，模型不会调用 search_web）');

  // 通讯录持久化：Postgres（见 infra/postgres）。连不上则明确报错，避免带病跑。
  const pool = createPool(cfg.databaseUrl);
  try {
    await ensureSchema(pool);
  } catch (e) {
    console.error('⚠️ 连不上 Postgres（' + cfg.databaseUrl + '）。先跑：cd infra/postgres && docker compose up -d');
    throw e;
  }
  const contacts = createContactsStore(pool);
  await contacts.seedDefaults(); // 新库首次启动预置默认伙伴（苏明悦）
  const sessions = createSessionsStore(pool); // 通话会话记录（L4 过度依赖的行为信号来源）
  const transcript = createTranscriptStore(pool); // 逐轮聊天记录（导出/优化用）

  // 可观测：包装 LLM/embedding，运行时通话埋点（无 LANGFUSE key 时整体 no-op）。
  const obs = createObs({ publicKey: cfg.langfusePublicKey, secretKey: cfg.langfuseSecretKey, baseUrl: cfg.langfuseBaseUrl });
  const llm = obs.wrapLlm(new DeepSeek({ apiKey: cfg.deepseekApiKey, baseUrl: cfg.deepseekBaseUrl }), 'deepseek');
  // L4 安全红线小模型（阿里云百炼 qwen，OpenAI 兼容端点，复用 DashScope key）。
  const safetyLlm = obs.wrapLlm(new DeepSeek({ apiKey: cfg.dashscopeApiKey, baseUrl: cfg.safetyBaseUrl }), 'safety-qwen');
  // 长期记忆：embedding（百炼）+ pgvector 混合召回。未配 embedding key 时 recall 降级为空记忆。
  const embedder = obs.wrapEmbedder(createEmbedder({ apiKey: cfg.embeddingApiKey, baseUrl: cfg.embeddingBaseUrl, model: cfg.embeddingModel }), 'embed', cfg.embeddingModel);
  const memory = createMemoryStore(pool, embedder, { recallTopK: cfg.memoryRecallTopK });
  const askedQuestions = createAskedQuestionsStore(pool); // 近 3 天已问过的问题（防重复提问）
  const conversationSummaries = createConversationSummariesStore(pool); // 最近 3 天对话概要（跨通话「最近聊过什么」）
  const selfAdded = createSelfAddedStore(pool); // 人设增补：陪伴者底座之外的软细节
  const goals = createGoalsStore(pool); // 成长课题：Life Coach 的跨会话轨迹（重骨架）
  const holidayMap = await loadHolidayMap(shanghaiParts(new Date()).year); // 节假日/工作日判定
  const timeAware = createTimeAware(memory, holidayMap); // 时间感知（L5）
  const summarizer = createSummarizer(llm, cfg.generateModel);
  // 上下文窗口预算：压缩只打 L5 历史。窗口切分（合计约 85%，留余量给 system prompt 等固定成本）：
  // L2 记忆 35% + L5 历史 50%；记忆块内部还有约束子预算 40%（见 context.ts CONSTRAINT_BUDGET_RATIO）。
  const memoryBudget = Math.floor(cfg.contextMaxTokens * 0.35);
  const historyBudget = Math.floor(cfg.contextMaxTokens * 0.5);
  const userId = 'demo-user'; // 尚未有账号体系，先固定单用户；接鉴权后按会话取 userId。

  // 单会话编排：一通电话的所有实时状态与流程（ASR→L3→TTS + 主动发话 + 抢话）。
  const session = new CallSession({
    cfg, llm, safetyLlm, embedder, memory, askedQuestions, conversationSummaries,
    selfAdded, goals, sessions, transcript, obs, timeAware, summarizer, memoryBudget, historyBudget, userId,
  });
  session.preloadGreetings(); // 启动即预热上线人物的招呼语（第一句秒回）

  const router = createRouter({
    contacts,
    memory,
    transcript,
    userId,
    defaultPersona: () => session.personaName,
    onRtcOffer: (body) => session.handleOffer(body),
  });
  const server = createServer((req, res) => router(req, res));

  const PORT = Number(process.env.PORT ?? 3001);
  server.listen(PORT, () => {
    console.log(`实时通话服务已启动：http://localhost:${PORT}（信令 /rtc/offer）`);
  });

  // 做梦：空闲时自动巩固记忆（合并去重 + 清理矛盾 + 抽象升级）。有通话时跳过。
  const DREAM_INTERVAL_MS = 3 * 60 * 1000; // 每 3 分钟扫一次
  let dreaming = false;
  const lastDreamAt = new Map<string, string>(); // persona.name → 上次做梦完成时间（ISO），脏标记
  async function runDreamIfIdle() {
    if (session.isInCall || dreaming) return; // 正在通话 / 上一轮还没跑完就跳过
    dreaming = true;
    try {
      for (const p of Object.values(PERSONAS)) {
        if (!p.available) continue;
        try {
          const prev = lastDreamAt.get(p.name);
          if (prev) {
            const fresh = await memory.listAll(p.name, userId, { since: prev });
            if (fresh.length === 0) continue;
          }
          const r = await dreamOnMemory({ llm, model: cfg.generateModel, store: memory, embedder, userId, personaName: p.name });
          lastDreamAt.set(p.name, new Date().toISOString());
          console.log(`[dream] ${p.name}：抽象 ${r.abstractedFacts}f/${r.abstractedProfile}p，合并 ${r.merged} 条，清矛盾 ${r.resolved} 条`);
        } catch (e) {
          console.warn(`[dream] ${p.name} 做梦失败：`, e);
        }
      }
    } finally {
      dreaming = false;
    }
  }
  setInterval(runDreamIfIdle, DREAM_INTERVAL_MS);

  // 进程退出前 flush 一次 LangFuse（后台批量，避免最后几个 trace 丢在缓冲区）。
  const shutdown = (sig: string) => {
    console.log(`[obs] 收到 ${sig}，flush LangFuse 后退出`);
    obs.shutdown().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// 直接运行时（npm start → tsx apps/server/src/run.ts）由 run.ts 调用 main；
// Electron 主进程 import { main } 后自行调用。这里不再自动执行。
