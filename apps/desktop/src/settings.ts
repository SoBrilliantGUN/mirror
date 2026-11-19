// 设置存储：secret 字段用 Electron safeStorage（Windows = DPAPI）加密落盘，非 secret 字段明文。
import { app, safeStorage } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

export interface Settings {
  // —— 必填（填了才能通话）——
  deepseekApiKey: string;
  dashscopeApiKey: string;
  // —— 可选（空则用 server 侧默认）——
  deepseekBaseUrl?: string;
  dashscopeBaseUrl?: string;       // HTTP（离线合成）+ WS 中转主端点
  dashscopeWsUrl?: string;
  dashscopeWsFallbackUrl?: string;
  dashscopeOfficialApiKey?: string; // TTS 兜底端点（官方百炼 key）
  embeddingApiKey?: string;         // 空则复用 dashscopeApiKey
  cosyvoiceVoice?: string;          // 程书衡音色
  cosyvoiceVoiceSzy?: string;       // 沈知遥音色
  cosyvoiceVoiceSyq?: string;       // 沈砚秋音色
  cosyvoiceVoiceSmy?: string;       // 苏明悦音色
  cosyvoiceVoiceEn?: string;        // 程书衡英文音色
  cosyvoiceVoiceSzyEn?: string;     // 沈知遥英文音色
  cosyvoiceVoiceSyqEn?: string;     // 沈砚秋英文音色
  cosyvoiceVoiceSmyEn?: string;     // 苏明悦英文音色
  bochaApiKey?: string;             // 联网搜索
  nlsEnabled?: boolean;             // 哭/笑检测总开关
  nlsAppKey?: string;
  nlsToken?: string;
  nlsAkId?: string;
  nlsAkSecret?: string;
}

// 需要加密保存的字段（密钥/令牌/访问凭据）。base URL、音色 ID 等非敏感信息明文。
const SECRET_FIELDS = new Set<string>([
  'deepseekApiKey',
  'dashscopeApiKey',
  'dashscopeOfficialApiKey',
  'embeddingApiKey',
  'bochaApiKey',
  'nlsAppKey',
  'nlsToken',
  'nlsAkId',
  'nlsAkSecret',
]);

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

export function loadSettings(): Settings {
  const p = settingsPath();
  if (!existsSync(p)) return { deepseekApiKey: '', dashscopeApiKey: '' };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (SECRET_FIELDS.has(k) && typeof v === 'string' && v.startsWith('enc:')) {
        try {
          out[k] = safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
        } catch (e) {
          console.warn('[settings] 解密字段失败', k, e);
          out[k] = '';
        }
      } else {
        out[k] = v;
      }
    }
    return out as unknown as Settings;
  } catch (e) {
    console.error('[settings] 读取失败', e);
    return { deepseekApiKey: '', dashscopeApiKey: '' };
  }
}

export function saveSettings(s: Settings): void {
  const p = settingsPath();
  mkdirSync(app.getPath('userData'), { recursive: true });
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (SECRET_FIELDS.has(k) && typeof v === 'string' && v) {
      out[k] = 'enc:' + safeStorage.encryptString(v).toString('base64');
    } else {
      out[k] = v;
    }
  }
  writeFileSync(p, JSON.stringify(out, null, 2));
}

// 把设置映射成 server 子进程的环境变量。
export function settingsToEnv(s: Settings): Record<string, string> {
  const env: Record<string, string> = {};
  if (s.deepseekApiKey) env.DEEPSEEK_API_KEY = s.deepseekApiKey;
  if (s.deepseekBaseUrl) env.DEEPSEEK_BASE_URL = s.deepseekBaseUrl;
  if (s.dashscopeApiKey) env.DASHSCOPE_API_KEY = s.dashscopeApiKey;
  if (s.dashscopeBaseUrl) env.DASHSCOPE_BASE_URL = s.dashscopeBaseUrl;
  if (s.dashscopeWsUrl) env.DASHSCOPE_WS_URL = s.dashscopeWsUrl;
  if (s.dashscopeWsFallbackUrl) env.DASHSCOPE_WS_FALLBACK_URL = s.dashscopeWsFallbackUrl;
  if (s.dashscopeOfficialApiKey) env.DASHSCOPE_OFFICIAL_API_KEY = s.dashscopeOfficialApiKey;
  if (s.embeddingApiKey) env.EMBEDDING_API_KEY = s.embeddingApiKey;
  if (s.cosyvoiceVoice) env.COSYVOICE_VOICE = s.cosyvoiceVoice;
  if (s.cosyvoiceVoiceSzy) env.COSYVOICE_VOICE_SZY = s.cosyvoiceVoiceSzy;
  if (s.cosyvoiceVoiceSyq) env.COSYVOICE_VOICE_SYQ = s.cosyvoiceVoiceSyq;
  if (s.cosyvoiceVoiceSmy) env.COSYVOICE_VOICE_SMY = s.cosyvoiceVoiceSmy;
  if (s.cosyvoiceVoiceEn) env.COSYVOICE_VOICE_EN = s.cosyvoiceVoiceEn;
  if (s.cosyvoiceVoiceSzyEn) env.COSYVOICE_VOICE_SZY_EN = s.cosyvoiceVoiceSzyEn;
  if (s.cosyvoiceVoiceSyqEn) env.COSYVOICE_VOICE_SYQ_EN = s.cosyvoiceVoiceSyqEn;
  if (s.cosyvoiceVoiceSmyEn) env.COSYVOICE_VOICE_SMY_EN = s.cosyvoiceVoiceSmyEn;
  if (s.bochaApiKey) env.BOCHA_API_KEY = s.bochaApiKey;
  if (s.nlsEnabled === false) env.NLS_ENABLED = 'false';
  if (s.nlsAppKey) env.NLS_APPKEY = s.nlsAppKey;
  if (s.nlsToken) env.NLS_ACCESS_TOKEN = s.nlsToken;
  if (s.nlsAkId) env.NLS_ACCESS_KEY_ID = s.nlsAkId;
  if (s.nlsAkSecret) env.NLS_ACCESS_KEY_SECRET = s.nlsAkSecret;
  return env;
}
