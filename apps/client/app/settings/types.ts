// 设置模型：与 Electron 主进程（apps/desktop/src/settings.ts）保持一致。
export interface Settings {
  deepseekApiKey: string;
  dashscopeApiKey: string;
  userName?: string;
  deepseekBaseUrl?: string;
  dashscopeBaseUrl?: string;
  dashscopeWsUrl?: string;
  dashscopeWsFallbackUrl?: string;
  dashscopeOfficialApiKey?: string;
  embeddingApiKey?: string;
  cosyvoiceVoice?: string;
  cosyvoiceVoiceSzy?: string;
  cosyvoiceVoiceSyq?: string;
  cosyvoiceVoiceSmy?: string;
  cosyvoiceVoiceEn?: string;
  cosyvoiceVoiceSzyEn?: string;
  cosyvoiceVoiceSyqEn?: string;
  cosyvoiceVoiceSmyEn?: string;
  bochaApiKey?: string;
  nlsEnabled?: boolean;
  nlsAppKey?: string;
  nlsToken?: string;
  nlsAkId?: string;
  nlsAkSecret?: string;
}
