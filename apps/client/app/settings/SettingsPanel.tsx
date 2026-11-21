'use client';

import { useEffect, useState } from 'react';
import type { Settings } from './types';

const DEFAULT: Settings = { deepseekApiKey: '', dashscopeApiKey: '' };

type FieldProps = {
  k: keyof Settings;
  label: string;
  secret?: boolean;
  placeholder?: string;
  s: Settings;
  update: (k: keyof Settings, v: string) => void;
};

function Field({ k, label, secret, placeholder, s, update }: FieldProps) {
  return (
    <label className="sfield">
      <span className="sf-label">{label}</span>
      <input
        type={secret ? 'password' : 'text'}
        value={String(s[k] ?? '')}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => update(k, e.target.value)}
      />
    </label>
  );
}

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings>(DEFAULT);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    window.mirrorSettings?.get().then((x) => {
      setS({ ...DEFAULT, ...x });
      setLoaded(true);
    });
  }, []);

  const update = (k: keyof Settings, v: string) => setS((p) => ({ ...p, [k]: v }));

  async function save() {
    await window.mirrorSettings?.set(s);
    setSaved(true);
  }

  const f = (k: keyof Settings, label: string, opts?: { secret?: boolean; placeholder?: string }) => (
    <Field key={k} k={k} label={label} secret={opts?.secret} placeholder={opts?.placeholder} s={s} update={update} />
  );

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-h">
          <h3>⚙ 设置</h3>
          <button className="panel-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="panel-body settings-body">
          <p className="settings-hint">填好 API key 并保存后，重启应用生效。没填 key 时无法通话。你的 key 会用系统凭据库加密保存在本机。</p>

          <h4 className="settings-h4">必填</h4>
          {f('deepseekApiKey', 'DeepSeek API Key（大脑）', { secret: true, placeholder: 'sk-...' })}
          {f('dashscopeApiKey', '阿里云百炼 API Key（语音 + 安全 + 记忆）', { secret: true, placeholder: 'sk-...' })}

          <h4 className="settings-h4">你的名字（可选）</h4>
          {f('userName', '你的名字', { placeholder: '比如：张渔歌' })}
          <p className="settings-hint">填了之后，语音识别若把名字听成同音字（如「章宇哥」），AI 会以这里为准，不再纠结写法。</p>

          <button className="adv-toggle" onClick={() => setAdvanced(!advanced)}>
            {advanced ? '▾ 收起高级设置' : '▸ 高级设置（音色 / 搜索 / 哭笑脸 / 中转地址）'}
          </button>

          {advanced && (
            <div className="adv-body">
              <h5 className="settings-h5">地址与兜底</h5>
              {f('dashscopeBaseUrl', '百炼 Base URL（HTTP）', { placeholder: 'https://dashscope.aliyuncs.com' })}
              {f('dashscopeWsUrl', '实时语音 WS 端点', { placeholder: 'wss://…' })}
              {f('dashscopeWsFallbackUrl', 'TTS 兜底 WS 端点', { placeholder: 'wss://…' })}
              {f('dashscopeOfficialApiKey', '官方百炼 Key（TTS 兜底）', { secret: true })}
              {f('embeddingApiKey', 'Embedding Key（空则复用百炼）', { secret: true })}

              <h5 className="settings-h5">音色 ID（4 位陪伴者，CosyVoice 自定义音色）</h5>
              {f('cosyvoiceVoice', '程书衡（男）')}
              {f('cosyvoiceVoiceSzy', '沈知遥（女）')}
              {f('cosyvoiceVoiceSyq', '沈砚秋（男）')}
              {f('cosyvoiceVoiceSmy', '苏明悦（女）')}
              <h5 className="settings-h5">英文音色 ID（练英语用，未填则英文回落中文音色·带口音）</h5>
              {f('cosyvoiceVoiceEn', '程书衡 英文（男）')}
              {f('cosyvoiceVoiceSzyEn', '沈知遥 英文（女）')}
              {f('cosyvoiceVoiceSyqEn', '沈砚秋 英文（男）')}
              {f('cosyvoiceVoiceSmyEn', '苏明悦 英文（女）')}

              <h5 className="settings-h5">联网搜索（博查，可选）</h5>
              {f('bochaApiKey', 'Bocha API Key', { secret: true })}

              <h5 className="settings-h5">哭/笑检测（阿里 NLS，可选）</h5>
              {f('nlsAppKey', 'NLS AppKey')}
              {f('nlsToken', 'NLS Token（优先）', { secret: true })}
              {f('nlsAkId', 'AccessKey ID')}
              {f('nlsAkSecret', 'AccessKey Secret', { secret: true })}

              <h5 className="settings-h5">窗口（重启后生效）</h5>
              <label className="sfield">
                <span className="sf-label">启动时最大化</span>
                <input type="checkbox" checked={!!s.maximize} onChange={(e) => setS((p) => ({ ...p, maximize: e.target.checked }))} />
              </label>
              {!s.maximize && (
                <>
                  <label className="sfield">
                    <span className="sf-label">窗口宽度（px，留空 = 屏幕 85%）</span>
                    <input type="number" value={s.windowWidth ?? ''} placeholder="留空 = 屏幕 85%" min={400} onChange={(e) => setS((p) => ({ ...p, windowWidth: e.target.value === '' ? undefined : Number(e.target.value) }))} />
                  </label>
                  <label className="sfield">
                    <span className="sf-label">窗口高度（px，留空 = 屏幕 85%）</span>
                    <input type="number" value={s.windowHeight ?? ''} placeholder="留空 = 屏幕 85%" min={300} onChange={(e) => setS((p) => ({ ...p, windowHeight: e.target.value === '' ? undefined : Number(e.target.value) }))} />
                  </label>
                </>
              )}
            </div>
          )}

          <div className="settings-actions">
            <button className="save-btn" onClick={save} disabled={!loaded}>保存</button>
            {saved && (
              <button className="restart-btn" onClick={() => window.mirrorSettings?.restart()}>重启生效</button>
            )}
          </div>
          {saved && <p className="saved-note">已保存。重启后生效（记忆数据会保留）。</p>}
        </div>
      </div>
    </div>
  );
}
