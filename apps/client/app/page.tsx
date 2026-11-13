'use client';

import { useEffect, useRef, useState } from 'react';
import { COMPANIONS, type Companion } from './companions.generated';

const getServer = () => process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3001';

const CallIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
  </svg>
);

const InfoIcon = ({ size = 17 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" strokeLinecap="round" />
  </svg>
);

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
    <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
    <path d="M20 20l-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

const TrashIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 11v6M14 11v6" strokeLinecap="round" />
  </svg>
);

export default function Page() {
  const [view, setView] = useState<'contacts' | 'add' | 'detail' | 'call'>('contacts');
  const [companion, setCompanion] = useState<Companion | null>(null);
  const [detailBack, setDetailBack] = useState<'contacts' | 'add'>('contacts'); // 详情页从哪进来的，返回时回对地方
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState<string | null>(null); // 全局顶部浮层提示（后端断开等）
  const [muted, setMuted] = useState(false); // 静音开关
  const [safety, setSafety] = useState<{ level: number; resources: { name: string; number: string; note?: string }[] } | null>(null); // L4 安全 overlay

  // 启动时从服务端拉已添加的伙伴（持久化在 Postgres，见 store/contacts.ts）
  useEffect(() => {
    fetch(`${getServer()}/contacts`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d: { names: string[] }) => {
        const m: Record<string, boolean> = {};
        (d.names ?? []).forEach((n) => (m[n] = true));
        setAdded(m);
      })
      .catch(() => {
        /* 服务没起时保持空，不打扰 */
      });
  }, []);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const vadRunningRef = useRef(false);
  const audioElsRef = useRef<HTMLAudioElement[]>([]); // 挂断时清理的 <audio> 节点
  const healthTimerRef = useRef<ReturnType<typeof setInterval> | null>(null); // 后端健康轮询
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 浮层自动消失定时器

  async function start(c: Companion) {
    try {
      setNotice(null); // 清掉可能残留的浮层提示
      setSafety(null); // 清掉残留的安全 overlay
      setMuted(false); // 新通话从非静音开始
      setStatus('连接中…');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      const dc = pc.createDataChannel('control');
      dcRef.current = dc;
      dc.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === 'hangup') hangup(); // 服务端说"不打扰"后 10s 挂断
          if (msg.type === 'safety') setSafety({ level: msg.level, resources: msg.resources }); // L4 危机：屏幕兜底显示热线
        } catch {
          /* 非 JSON 忽略 */
        }
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
        audioElsRef.current.push(el); // 记下来，挂断时统一摘除
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      const res = await fetch(`${getServer()}/rtc/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: pc.localDescription?.sdp ?? offer.sdp, name: c.name }),
      });
      if (!res.ok) throw new Error('信令 HTTP ' + res.status);
      const { sdp } = await res.json();
      await pc.setRemoteDescription({ type: 'answer', sdp });

      setStatus('已接通，开始说话吧');
      startVad(stream, audioCtx);
      startHealthPoll();
    } catch (e) {
      console.error('接通失败：', e);
      setStatus('出错：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') finish();
      });
      setTimeout(finish, 3000);
    });
  }

  function startVad(stream: MediaStream, audioCtx: AudioContext) {
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    // 迟滞（进/出阈值不同）+ 最小时长去抖：软语速抢话能抓住，咳嗽/底噪短脉冲不误触发。
    const ON_RMS = 0.06;        // 进入"在说话"的阈值（比原来 0.08 更灵敏）
    const OFF_RMS = 0.03;       // 退出阈值低于进入，形成迟滞，避免说话中的停顿反复触发
    const MIN_SPEECH_MS = 120;  // 持续说满这么久才发 interrupt（滤掉短脉冲）
    let wasSpeaking = false;
    let speakingSince = 0;
    let interruptSent = false;

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const speaking = rms > (wasSpeaking ? OFF_RMS : ON_RMS);
      if (speaking && !wasSpeaking) {
        speakingSince = performance.now();
        interruptSent = false; // 新一轮发声，允许再发一次 interrupt
      }
      if (speaking && !interruptSent && performance.now() - speakingSince >= MIN_SPEECH_MS) {
        interruptSent = true; // 这一段发声只发一次
        if (dcRef.current?.readyState === 'open') {
          dcRef.current.send(JSON.stringify({ type: 'interrupt' }));
        }
      }
      wasSpeaking = speaking;
      if (vadRunningRef.current) requestAnimationFrame(tick);
    };
    vadRunningRef.current = true;
    tick();
  }

  function stop() {
    vadRunningRef.current = false;
    clearHealthPoll();
    // 挂断清理：摘掉所有残留 <audio> 节点 + 关闭 AudioContext，避免每次通话累积
    for (const el of audioElsRef.current) {
      try {
        el.pause();
        el.srcObject = null;
        el.remove();
      } catch {
        /* 已不在 DOM 或已释放，忽略 */
      }
    }
    audioElsRef.current = [];
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }

  function clearHealthPoll() {
    if (healthTimerRef.current !== null) {
      clearInterval(healthTimerRef.current);
      healthTimerRef.current = null;
    }
  }

  // 顶部浮层提示：显示一条消息，4s 后自动消失
  function showNotice(msg: string) {
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 4000);
  }

  // 轮询后端健康检查：后端进程挂了，前端立刻报错、中断通话并弹回通讯录（否则会静默黑屏）
  function startHealthPoll() {
    clearHealthPoll();
    const tick = async () => {
      try {
        const res = await fetch(`${getServer()}/health`, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
      } catch {
        stop();
        showNotice('连接已断开，对方不在线了');
        setView('contacts');
        setCompanion(null);
        setStatus('');
      }
    };
    healthTimerRef.current = setInterval(tick, 3000);
  }

  // 静音开关：禁用/启用麦克风音轨（track.enabled）。静音后麦克风输出静音，VAD 也不会误触发打断。
  function toggleMute() {
    const next = !muted;
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    setMuted(next);
  }

  async function addCompanion(c: Companion) {
    try {
      const res = await fetch(`${getServer()}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: c.name }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = (await res.json()) as { names: string[] };
      const m: Record<string, boolean> = {};
      (d.names ?? []).forEach((n) => (m[n] = true));
      setAdded(m);
    } catch (e) {
      console.error('添加伙伴失败：', e);
    }
  }

  async function removeCompanion(c: Companion) {
    try {
      const res = await fetch(`${getServer()}/contacts/${encodeURIComponent(c.name)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = (await res.json()) as { names: string[] };
      const m: Record<string, boolean> = {};
      (d.names ?? []).forEach((n) => (m[n] = true));
      setAdded(m);
    } catch (e) {
      console.error('移除伙伴失败：', e);
    }
  }

  function openDetail(c: Companion) {
    setCompanion(c);
    setDetailBack(view === 'add' ? 'add' : 'contacts');
    setView('detail');
  }

  function call(c: Companion) {
    if (!c.available) return;
    setCompanion(c);
    setView('call');
    start(c);
  }

  function hangup() {
    // 通知后端立刻停：别等 WebRTC 断连（ICE 失败有几秒延迟，期间后端还会继续输出）
    if (dcRef.current?.readyState === 'open') {
      dcRef.current.send(JSON.stringify({ type: 'hangup' }));
    }
    stop();
    setView('contacts');
    setCompanion(null);
    setStatus('');
    setSafety(null);
  }

  function backToList() {
    setView('contacts');
    setCompanion(null);
    setStatus('');
  }

  // 详情页返回：记住是从通讯录还是「添加伙伴」进来的，回对应页。
  function backFromDetail() {
    setCompanion(null);
    setStatus('');
    setView(detailBack);
  }

  const mono = (c: Companion) => c.name.slice(1);
  const addedList = COMPANIONS.filter((c) => added[c.name]);
  const filtered = addedList.filter(
    (c) => c.name.includes(query) || c.temperament.includes(query),
  );

  return (
    <>
      {view === 'contacts' && (
        <div className="contacts-view">
          <div className="navbar">
            <h1>通讯录</h1>
            <button className="add" onClick={() => setView('add')} aria-label="添加伙伴">＋</button>
          </div>
          <div className="search">
            <SearchIcon />
            <input
              placeholder="搜索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="section-label">我的伙伴 · {filtered.length} 位</div>
          {addedList.length === 0 ? (
            <div className="empty">
              还没有伙伴
              <br />
              点右上角 ＋ 添加
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty">没有找到匹配的伙伴</div>
          ) : (
            <ul className="contact-list">
              {filtered.map((c) => (
                <li className="contact" key={c.name}>
                  <div className="avatar" style={{ background: c.color }}>
                    {mono(c)}
                  </div>
                  <div className="meta">
                    <div className="name">{c.name}</div>
                    <div className="temper">{c.temperament}</div>
                  </div>
                  <div className="actions">
                    <button className="btn-info" title="看详情" onClick={() => openDetail(c)}>
                      <InfoIcon />
                    </button>
                    <button className="btn-call" title="打电话" onClick={() => call(c)}>
                      <CallIcon />
                    </button>
                    <button className="btn-remove" title="移除" onClick={() => removeCompanion(c)}>
                      <TrashIcon />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {view === 'add' && (
        <div className="add-view">
          <button className="back" onClick={backToList}>‹ 通讯录</button>
          <div className="add-title">添加伙伴</div>
          <div className="section-label">选择要添加的伙伴 · {COMPANIONS.length} 位</div>
          <ul className="contact-list">
            {COMPANIONS.map((c) => (
              <li className="contact" key={c.name}>
                <button className="contact-main" onClick={() => openDetail(c)} aria-label={`查看 ${c.name} 详情`}>
                  <div className="avatar" style={{ background: c.color }}>
                    {mono(c)}
                  </div>
                  <div className="meta">
                    <div className="name">{c.name}</div>
                    <div className="temper">{c.temperament}</div>
                  </div>
                </button>
                <button className="btn-detail" onClick={() => openDetail(c)}>详情</button>
                {added[c.name] ? (
                  <span className="added-pill">已添加</span>
                ) : c.available ? (
                  <button className="btn-add" onClick={() => addCompanion(c)}>添加</button>
                ) : (
                  <button className="btn-add" disabled>添加</button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view === 'detail' && companion && (
        <div className="detail-view">
          <button className="back" onClick={backFromDetail}>‹ 通讯录</button>
          <div className="detail-hero">
            <div className="avatar big" style={{ background: companion.color }}>
              {mono(companion)}
            </div>
            <div className="name">{companion.name}</div>
            <div className="temper">{companion.temperament}</div>
            <div className="meta-line">{companion.profession} · {companion.gender === '女' ? '她' : '他'}</div>
          </div>
          <div className="detail-section">
            <div className="h">关于 TA</div>
            <p>{companion.intro}</p>
          </div>
          <div className="detail-section">
            <div className="h">说话风格</div>
            <p>{companion.style}</p>
          </div>
          <div className="detail-section">
            <div className="h">TA 擅长帮你</div>
            <p>{companion.strength}</p>
          </div>
          <div className="detail-actions">
            <button className="call-primary" disabled={!companion.available} onClick={() => call(companion)}>
              <CallIcon />
              打电话
            </button>
          </div>
        </div>
      )}

      {view === 'call' && companion && (
        <div className="call-view">
          <button className="back" onClick={hangup}>‹ 结束</button>
          <div className="call-top">
            <div className="call-status">{status}</div>
            <div className="avatar big call-avatar" style={{ background: companion.color }}>
              {mono(companion)}
            </div>
            <div className="call-name">{companion.name}</div>
            <div className="call-temper">{companion.temperament}</div>
          </div>
          <div className="call-controls">
            <button
              className={`ctl${muted ? ' muted' : ''}`}
              title={muted ? '打开麦克风' : '关闭麦克风'}
              onClick={toggleMute}
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
                {muted && (
                  <path d="M6 6 L18 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" fill="none" />
                )}
              </svg>
              {muted ? '开麦' : '关麦'}
            </button>
            <button className="ctl hangup" onClick={hangup}>
              <CallIcon size={22} />
              挂断
            </button>
          </div>
        </div>
      )}

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
