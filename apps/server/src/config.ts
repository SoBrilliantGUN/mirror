export type Config = {
  // 存储
  databaseUrl: string;    // Postgres 连接串（通讯录 / 记忆）
  // L3 大脑
  deepseekApiKey: string;
  deepseekBaseUrl: string;
  scoreModel: string;     // 打分用（小输出，快速）
  generateModel: string;  // 生成用（流式）
  // L4 安全红线（阿里云百炼小模型，复用 DashScope key）
  safetyModel: string;    // 小模型分类调用（qwen-turbo 等）
  safetyBaseUrl: string;  // OpenAI 兼容 /chat/completions 端点
  // 长期记忆 embedding（阿里云百炼 OpenAI 兼容端点）
  embeddingApiKey: string;
  embeddingBaseUrl: string;  // 如 https://dashscope.aliyuncs.com/compatible-mode/v1 或百炼网关 /v1
  embeddingModel: string;    // text-embedding-v3 等
  embeddingDim: number;      // 向量维度，与模型对齐（v3 默认 1024）
  // 上下文窗口（参考 kima 六层窗口，压缩只打 L5 历史）
  contextMaxTokens: number;   // 模型窗口（deepseek-chat = 64K）
  memoryRecallTopK: number;   // 混合召回 top-k
  // L2 语音（阿里云百炼）
  dashscopeApiKey: string;
  dashscopeBaseUrl: string;   // HTTP（离线合成）
  dashscopeWsUrl: string;     // WebSocket（实时流式 TTS/ASR）
  dashscopeWsFallbackUrl: string;  // TTS 兜底 WS 端点（官方百炼；中转站挂了切过去）
  dashscopeOfficialApiKey: string; // 兜底端点专用 key（官方 key 与中转 key 不通用）
  cosyvoiceModel: string;
  cosyvoiceVoice: string;
  paraformerModel: string;    // 实时 ASR 模型
  // L2 非言语发声检测（哭/笑）：阿里云智能语音交互 NLS 声音事件检测（云端，零本地模型）
  nlsAppKey: string;    // NLS 项目 AppKey（StartDetection 命令 header 里要）
  nlsToken: string;     // 已拿好的 token（优先；设了就不走 CreateToken）
  nlsAkId: string;      // 阿里云 AccessKeyId（没 token 时走 CreateToken 签名）
  nlsAkSecret: string;  // 阿里云 AccessKeySecret
  // 联网搜索（博查 Web Search）：用户问陌生词 / 被事实纠正时真查；无 key 降级关闭
  bochaApiKey: string;
  bochaBaseUrl: string;
  // 可观测（LangFuse 自托管）：运行时通话埋点（session/trace/generation/event/score）。没配 key 则整体 no-op。
  langfusePublicKey: string;
  langfuseSecretKey: string;
  langfuseBaseUrl: string;
  // 实时语音 ICE（Docker 下浏览器直达容器的关键）
  iceHostAddress: string;       // 额外宣告的 ICE 主机地址：本地 127.0.0.1，远程填公网/LAN IP
  icePortRange: [number, number]; // ICE UDP 端口段（与 compose 发布的 udp 段一致）
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    databaseUrl: env.DATABASE_URL ?? '',
    deepseekApiKey: env.DEEPSEEK_API_KEY ?? '',
    deepseekBaseUrl: env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    scoreModel: env.SCORE_MODEL ?? 'deepseek-chat',
    generateModel: env.GENERATE_MODEL ?? 'deepseek-chat',
    safetyModel: env.SAFETY_MODEL ?? 'qwen-turbo',
    safetyBaseUrl: env.SAFETY_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    embeddingApiKey: env.EMBEDDING_API_KEY ?? env.DASHSCOPE_API_KEY ?? '',
    embeddingBaseUrl: env.EMBEDDING_BASE_URL ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    embeddingModel: env.EMBEDDING_MODEL ?? 'text-embedding-v3',
    embeddingDim: Number(env.EMBEDDING_DIM ?? 1024),
    contextMaxTokens: Number(env.CONTEXT_MAX_TOKENS ?? 64000),
    memoryRecallTopK: Number(env.MEMORY_RECALL_TOP_K ?? 5),
    dashscopeApiKey: env.DASHSCOPE_API_KEY ?? '',
    dashscopeBaseUrl: env.DASHSCOPE_BASE_URL ?? 'https://maas.qianwenaiapi.com',
    dashscopeWsUrl: env.DASHSCOPE_WS_URL ?? 'wss://maas.qianwenaiapi.com/api-ws/v1/inference',
    dashscopeWsFallbackUrl: env.DASHSCOPE_WS_FALLBACK_URL ?? 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    dashscopeOfficialApiKey: env.DASHSCOPE_OFFICIAL_API_KEY ?? '',
    cosyvoiceModel: env.COSYVOICE_MODEL ?? 'cosyvoice-v3.5-plus',
    cosyvoiceVoice: env.COSYVOICE_VOICE ?? '',
    paraformerModel: env.PARAFORMER_MODEL ?? 'paraformer-realtime-v2',
    nlsAppKey: env.NLS_APPKEY ?? '',
    nlsToken: env.NLS_ACCESS_TOKEN ?? '',
    nlsAkId: env.NLS_ACCESS_KEY_ID ?? '',
    nlsAkSecret: env.NLS_ACCESS_KEY_SECRET ?? '',
    bochaApiKey: env.BOCHA_API_KEY ?? '',
    bochaBaseUrl: env.BOCHA_BASE_URL ?? 'https://api.bochaai.com/v1',
    langfusePublicKey: env.LANGFUSE_PUBLIC_KEY ?? '',
    langfuseSecretKey: env.LANGFUSE_SECRET_KEY ?? '',
    langfuseBaseUrl: env.LANGFUSE_BASEURL ?? 'http://localhost:3002',
    iceHostAddress: env.ICE_HOST_ADDRESS ?? '127.0.0.1',
    icePortRange: parsePortRange(env.ICE_PORT_RANGE),
  };
}

// "50000-50100" → [50000, 50100]；非法或缺省回退到 50000-50100。
function parsePortRange(raw: string | undefined): [number, number] {
  const [min, max] = (raw ?? '50000-50100').split('-').map((n) => Number(n));
  if (!Number.isInteger(min) || !Number.isInteger(max) || min >= max) return [50000, 50100];
  return [min, max];
}

// 加载 .env（Node 21.7+ 内置，无额外依赖）。不存在也没关系，走 shell 环境变量。
export function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // 忽略：没有 .env 时用 shell 环境变量
  }
}
