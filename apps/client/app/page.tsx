'use client';

import { useEffect, useRef, useState } from 'react';
import { COMPANIONS, type Companion } from './companions.generated';
import MemoryLibrary from './memories/MemoryLibrary';
import SettingsPanel from './settings/SettingsPanel';

const getServer = () => process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3001';

type Mem = { id: string; kind: string; content: string; createdAt: string };
type TranscriptRow = { role: 'user' | 'agent'; text: string };

const KIND_LABEL: Record<string, string> = {
  fact: '事实', preference: '偏好', episodic: '情节', profile: '人设', constraint: '约束',
};
// 笔记本展示的四类（constraint 是内部红线，不进「关于对方」的记忆面板）
const SHOW_KINDS = ['fact', 'preference', 'episodic', 'profile'];
const chipClass = (k: string) => (k === 'profile' ? 'persona' : k);

const CallIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
  </svg>
);

export default function Page() {
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isElectron, setIsElectron] = useState(false);
  const [keysMissing, setKeysMissing] = useState(false);

  const [inCall, setInCall] = useState(false);
  const [status, setStatus] = useState('');
  const [muted, setMuted] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptRow[]>([]);
  const [callStartAt, setCallStartAt] = useState<string | null>(null);
  const [memories, setMemories] = useState<Mem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [safety, setSafety] = useState<{ level: number; resources: { name: string; number: string; note?: string }[] } | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const vadRunningRef = useRef(false);
  const audioElsRef = useRef<HTMLAudioElement[]>([]);
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const memTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const selectedCompanion: Companion | null = selected ? COMPANIONS.find((c) => c.name === selected) ?? null : null;

  // 桌面版（Electron）才显示设置入口
  useEffect(() => {
    setIsElectron(typeof window !== 'undefined' && !!window.mirrorSettings);
  }, []);

  // 启动时拉已添加的伙伴。服务端冷启动（内嵌 PG + 建表 + 播种默认伙伴）可能比前端晚就绪，
  // 单次 fetch 失败就再也不重试会把「默认添加苏明悦」吞掉——这里退避重试直到拉到。
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async (attempt: number) => {
      try {
        const r = await fetch(`${getServer()}/contacts`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const d = (await r.json()) as { names: string[] };
        if (cancelled) return;
        const m: Record<string, boolean> = {};
        (d.names ?? []).forEach((n) => (m[n] = true));
        setAdded(m);
      } catch {
        if (cancelled) return;
        if (attempt < 20) timer = setTimeout(() => load(attempt + 1), 500);
      }
    };
    load(0);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, []);

  // 滚动到底
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [transcript]);

  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 4000);
  };

  // 桌面版：缺 API key 时自动弹设置 + 右下角提示，并把打电话按钮禁用（未配 key 无法通话）。
  useEffect(() => {
    if (typeof window === 'undefined' || !window.mirrorSettings) return;
    window.mirrorSettings
      .get()
      .then((s) => {
        const missing = !s?.deepseekApiKey || !s?.dashscopeApiKey;
        setKeysMissing(missing);
        if (missing) {
          setSettingsOpen(true);
          showNotice('还没有设置 api key，暂无法使用');
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadMemories(since?: string | null) {
    if (!selected) { setMemories([]); return; }
    const url = `${getServer()}/memories?character=${encodeURIComponent(selected)}${since ? '&since=' + encodeURIComponent(since) : ''}`;
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const d = await r.json();
      setMemories((d.memories ?? []).filter((m: Mem) => SHOW_KINDS.includes(m.kind)));
    } catch { /* 后端未起，忽略 */ }
  }

  // 通话中定时拉新记忆（后台写记忆是异步的）
  useEffect(() => {
    if (inCall && callStartAt) {
      loadMemories(callStartAt);
      memTimerRef.current = setInterval(() => loadMemories(callStartAt), 4000);
    }
    return () => { if (memTimerRef.current) clearInterval(memTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCall, callStartAt, selected]);

  function select(name: string) {
    if (inCall) return;
    setSelected(name);
    setTranscript([]);
    setCallStartAt(null);
    setMemories([]);
  }

  function startCall(c: Companion) {
    if (!c.available) return;
    setSelected(c.name);
    setTranscript([]);
    setMemories([]);
    setCallStartAt(new Date().toISOString());
    setInCall(true);
    start(c);
  }

  function start(c: Companion) {
    setNotice(null);
    setSafety(null);
    setMuted(false);
    setStatus('连接中…');
    navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(async (stream) => {
        streamRef.current = stream;
        const pc = new RTCPeerConnection();
        pcRef.current = pc;
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        const dc = pc.createDataChannel('control');
        dcRef.current = dc;
        dc.onmessage = (ev) => {
          try {
            const msg = JSON.parse(String(ev.data));
            if (msg.type === 'hangup') hangup();
            if (msg.type === 'safety') setSafety({ level: msg.level, resources: msg.resources });
            if (msg.type === 'transcript') {
              setTranscript((prev) => [...prev, { role: msg.role, text: String(msg.text ?? '') }]);
            }
          } catch { /* 非 JSON 忽略 */ }
        };

        const audioCtx = new AudioContext();
        audioCtxRef.current = audioCtx;
        audioCtx.resume().catch(() => {});
        pc.ontrack = (e) => {
          const stream2 = e.streams[0] ?? new MediaStream([e.track]);
          const el = document.createElement('audio');
          el.srcObject = stream2;
          el.autoplay = true;
          document.body.appendChild(el);
          el.play().catch(() => {});
          audioElsRef.current.push(el);
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);
        const res = await fetch(`${getServer()}/rtc/offer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sdp: pc.localDescription?.sdp ?? offer.sdp, name: c.name }),
        });
        if (!res.ok) {
          let msg = '信令 HTTP ' + res.status;
          try {
            const body = (await res.json()) as { error?: string };
            if (body?.error) msg = body.error;
          } catch { /* 非 JSON 响应，保留默认提示 */ }
          throw new Error(msg);
        }
        const { sdp } = await res.json();
        await pc.setRemoteDescription({ type: 'answer', sdp });

        setStatus('已接通，开始说话吧');
        startVad(stream, audioCtx);
        startHealthPoll();
      })
      .catch((e) => {
        console.error('接通失败：', e);
        setStatus('出错：' + (e instanceof Error ? e.message : String(e)));
      });
  }

  function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') finish(); });
      setTimeout(finish, 3000);
    });
  }

  function startVad(stream: MediaStream, audioCtx: AudioContext) {
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const ON_RMS = 0.06, OFF_RMS = 0.03, MIN_SPEECH_MS = 120;
    let wasSpeaking = false, speakingSince = 0, interruptSent = false;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / data.length);
      const speaking = rms > (wasSpeaking ? OFF_RMS : ON_RMS);
      if (speaking && !wasSpeaking) { speakingSince = performance.now(); interruptSent = false; }
      if (speaking && !interruptSent && performance.now() - speakingSince >= MIN_SPEECH_MS) {
        interruptSent = true;
        if (dcRef.current?.readyState === 'open') dcRef.current.send(JSON.stringify({ type: 'interrupt' }));
      }
      wasSpeaking = speaking;
      if (vadRunningRef.current) requestAnimationFrame(tick);
    };
    vadRunningRef.current = true;
    tick();
  }

  function stop() {
    vadRunningRef.current = false;
    if (memTimerRef.current) { clearInterval(memTimerRef.current); memTimerRef.current = null; }
    clearHealthPoll();
    for (const el of audioElsRef.current) {
      try { el.pause(); el.srcObject = null; el.remove(); } catch { /* ignore */ }
    }
    audioElsRef.current = [];
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  function clearHealthPoll() {
    if (healthTimerRef.current !== null) { clearInterval(healthTimerRef.current); healthTimerRef.current = null; }
  }

  function startHealthPoll() {
    clearHealthPoll();
    const tick = async () => {
      try {
        const res = await fetch(`${getServer()}/health`, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
      } catch {
        stop();
        showNotice('连接已断开，对方不在线了');
        setInCall(false);
        setStatus('');
      }
    };
    healthTimerRef.current = setInterval(tick, 3000);
  }

  function toggleMute() {
    const next = !muted;
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  }

  function hangup() {
    if (dcRef.current?.readyState === 'open') dcRef.current.send(JSON.stringify({ type: 'hangup' }));
    stop();
    setInCall(false);
    setStatus('');
    setSafety(null);
  }

  async function toggleAdd(c: Companion) {
    try {
      const method = added[c.name] ? 'DELETE' : 'POST';
      const url = added[c.name] ? `${getServer()}/contacts/${encodeURIComponent(c.name)}` : `${getServer()}/contacts`;
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'POST' ? JSON.stringify({ name: c.name }) : undefined,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = (await res.json()) as { names: string[] };
      const m: Record<string, boolean> = {};
      (d.names ?? []).forEach((n) => (m[n] = true));
      setAdded(m);
    } catch (e) { console.error('添加/移除伙伴失败：', e); }
  }

  async function editMemory(m: Mem) {
    const text = prompt('修改这条记忆：', m.content);
    if (text == null || !text.trim()) return;
    try {
      await fetch(`${getServer()}/memories/${m.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text.trim() }),
      });
      loadMemories(inCall ? callStartAt : null);
    } catch (e) { console.error('编辑记忆失败：', e); }
  }

  async function deleteMemory(m: Mem) {
    if (!confirm('删除这条记忆？（会从 AI 记忆里移除）')) return;
    try {
      await fetch(`${getServer()}/memories/${m.id}`, { method: 'DELETE' });
      loadMemories(inCall ? callStartAt : null);
    } catch (e) { console.error('删除记忆失败：', e); }
  }

  const mono = (c: Companion) => c.name.slice(1);
  const addedList = COMPANIONS.filter((c) => added[c.name]);
  const filtered = addedList.filter((c) => c.name.includes(query) || c.temperament.includes(query));

  return (
    <>
      <div className="blob b1" /><div className="blob b2" /><div className="blob b3" />
      <div className="topbar">
        <div className="tb-right">
          {isElectron && (
            <button className="settings-btn" onClick={() => setSettingsOpen(true)}>⚙ 设置</button>
          )}
        </div>
      </div>

      <div className="app">
        {/* 左：通讯录 */}
        <aside className="rail glass">
          <div className="rail-h">
            <h2>通讯录</h2>
            <button className="rail-add" onClick={() => setAddOpen(true)} aria-label="添加伙伴">＋</button>
          </div>
          <div className="search"><span>🔍</span><input placeholder="搜索伙伴" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <div className="list">
            {addedList.length === 0 ? (
              <div className="empty">还没有伙伴<br />点右上角 ＋ 添加</div>
            ) : filtered.length === 0 ? (
              <div className="empty">没有找到匹配的伙伴</div>
            ) : (
              filtered.map((c) => (
                <div className={`c${selected === c.name ? ' active' : ''}`} key={c.name} onClick={() => select(c.name)}>
                  <div className="avatar" style={{ background: c.color }}>{mono(c)}<span className={`dot ${c.available ? 'on' : 'off'}`} /></div>
                  <div className="cm">
                    <div className="cn">{c.name}</div>
                    <div className="ct">{c.temperament}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>

        {/* 中：对话 / 通话 */}
        <main className="chat glass">
          {!inCall && (
            <div className="idle">
              {selectedCompanion ? (
                <div className="idle-card">
                  <div className="avatar big" style={{ background: selectedCompanion.color }}>{mono(selectedCompanion)}</div>
                  <div className="name" style={{ fontSize: 20, fontWeight: 700 }}>{selectedCompanion.name}</div>
                  <div className="temper">{selectedCompanion.temperament}</div>
                  <div className="meta">{selectedCompanion.profession} · {selectedCompanion.gender === '女' ? '她' : '他'}</div>
                  <div className="intro">{selectedCompanion.intro}</div>
                  <button className="call-btn" disabled={!selectedCompanion.available || keysMissing} onClick={() => startCall(selectedCompanion)}>
                    <CallIcon /> 打电话
                  </button>
                </div>
              ) : (
                <div className="hint">在左边选一位伙伴<br />点「打电话」开始对话<br /><br />通话时这里会实时显示文字记录（只回看，不改）</div>
              )}
            </div>
          )}

          {inCall && selectedCompanion && (
            <>
              <div className="chat-h">
                <div className="avatar" style={{ background: selectedCompanion.color }}>{mono(selectedCompanion)}</div>
                <div>
                  <div className="name">{selectedCompanion.name}</div>
                  <div className="status">{status || selectedCompanion.temperament}</div>
                </div>
                <div className="live"><span className="pulse" />通话中</div>
              </div>
              <div className="transcript" ref={transcriptRef}>
                {transcript.length === 0 ? (
                  <div className="transcript-empty">文字记录会出现在这里…</div>
                ) : (
                  transcript.map((t, i) => (
                    <div className={`row ${t.role === 'user' ? 'user' : 'ai'}`} key={i}>
                      <div className="bubble">{t.text}</div>
                      <div className="who">{t.role === 'user' ? '我' : selectedCompanion.name}</div>
                    </div>
                  ))
                )}
                <div className="speaking"><i /><i /><i />对方正在说…</div>
              </div>
              <div className="controls">
                <button className={`ctl${muted ? ' muted' : ''}`} onClick={toggleMute}>{muted ? '🎙️ 开麦' : '🎙️ 关麦'}</button>
                <button className="ctl hangup" onClick={hangup}>📞 挂断</button>
              </div>
            </>
          )}
        </main>

        {/* 右：笔记本 */}
        <aside className="book glass">
          <div className="book-h">
            <h2>📓 笔记本</h2>
            {selectedCompanion && <button className="more" onClick={() => setLibOpen(true)}>更多记忆 →</button>}
          </div>
          <div className="scope">{inCall ? '本次对话产生的记忆' : selectedCompanion ? `${selectedCompanion.name} 记得的（开始通话后显示本次对话）` : '选择一个伙伴'}</div>
          <div className="mem">
            {!selectedCompanion ? (
              <div className="empty">选一位伙伴后<br />这里显示 TA 关于你的记忆</div>
            ) : memories.length === 0 ? (
              <div className="empty">{inCall ? '还没产生新记忆<br />聊几句就有了' : '暂无本次对话的记忆'}</div>
            ) : (
              memories.map((m) => (
                <div className="m" key={m.id}>
                  <div className="mh">
                    <span className={`chip ${chipClass(m.kind)}`}>{KIND_LABEL[m.kind] ?? m.kind}</span>
                    <button className="del" onClick={() => deleteMemory(m)} title="删除">✕</button>
                  </div>
                  <div className="mb">{m.content}</div>
                  <button className="edit" onClick={() => editMemory(m)}>编辑</button>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>

      {/* 添加伙伴弹层 */}
      {addOpen && (
        <div className="overlay" onClick={() => setAddOpen(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="panel-h">
              <h3>添加伙伴</h3>
              <button className="panel-close" onClick={() => setAddOpen(false)}>✕</button>
            </div>
            <div className="panel-body">
              {COMPANIONS.map((c) => (
                <div className="add-row" key={c.name}>
                  <div className="avatar" style={{ background: c.color }}>{mono(c)}<span className={`dot ${c.available ? 'on' : 'off'}`} /></div>
                  <div className="meta">
                    <div className="name">{c.name}</div>
                    <div className="temper">{c.temperament}</div>
                  </div>
                  {added[c.name] ? (
                    <button className="added-pill" onClick={() => toggleAdd(c)}>已添加</button>
                  ) : c.available ? (
                    <button className="add-btn" onClick={() => toggleAdd(c)}>添加</button>
                  ) : (
                    <button className="add-btn" disabled>未上线</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {libOpen && selectedCompanion && (
        <MemoryLibrary character={selectedCompanion.name} onClose={() => setLibOpen(false)} />
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      {notice && <div className="toast">{notice}</div>}

      {safety && (
        <div className="safety-overlay">
          <div className="safety-card">
            <div className="safety-title">请别一个人扛</div>
            <div className="safety-sub">此刻可以联系这些真人帮助（24 小时）：</div>
            <ul className="safety-list">
              {safety.resources.map((r) => (
                <li key={r.number}>
                  <a href={`tel:${r.number}`}>{r.name} {r.number}</a>
                  {r.note ? <span className="safety-note">（{r.note}）</span> : null}
                </li>
              ))}
            </ul>
            <button className="safety-close" onClick={() => setSafety(null)}>我知道了</button>
          </div>
        </div>
      )}
    </>
  );
}
