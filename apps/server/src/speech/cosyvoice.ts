export const DEFAULT_MODEL = 'cosyvoice-v3.5-plus';

export type CosyVoiceOptions = {
  model?: string;
  voice?: string;              // 音色 ID（系统音色 / 复刻 / 设计音色）
  format?: 'mp3' | 'wav' | 'pcm';
  sampleRate?: number;
  rate?: number;               // 语速 [0.5, 2.0]，默认 1.0
  pitch?: number;              // 音调 [0.5, 2.0]，默认 1.0
  baseUrl?: string;
};

// 非流式合成：text + 已组合好的 instruction → 音频 bytes。
// 阿里云百炼 SpeechSynthesizer：情绪通过独立的 input.instruction 字段传入。
export async function synthesize(
  apiKey: string,
  text: string,
  instruction: string,
  opts: CosyVoiceOptions = {},
): Promise<ArrayBuffer> {
  const baseUrl = opts.baseUrl ?? 'https://maas.qianwenaiapi.com';
  const url = `${baseUrl}/api/v1/services/audio/tts/SpeechSynthesizer`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model ?? DEFAULT_MODEL,
      input: {
        text,
        voice: opts.voice,
        instruction,
        format: opts.format ?? 'mp3',
        sample_rate: opts.sampleRate ?? 44100,
        rate: opts.rate ?? 1.0,
        pitch: opts.pitch ?? 1.0,
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`CosyVoice 合成失败: ${res.status} ${await res.text()}`);
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    const data = (await res.json()) as {
      output?: { audio?: { data?: string; url?: string } };
    };
    const audio = data.output?.audio;
    if (audio?.data) {
      const b64 = audio.data.replace(/^data:[^;]+;base64,/, '');
      return new Uint8Array(Buffer.from(b64, 'base64')).buffer;
    }
    if (audio?.url) {
      const r = await fetch(audio.url);
      if (!r.ok) throw new Error(`下载音频失败: ${r.status}`);
      return r.arrayBuffer();
    }
    throw new Error(`CosyVoice 响应里没找到音频：${JSON.stringify(data).slice(0, 200)}`);
  }
  return res.arrayBuffer();
}
