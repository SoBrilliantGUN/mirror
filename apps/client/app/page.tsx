'use client';

import { useEffect, useRef, useState } from 'react';
import { COMPANIONS, type Companion } from './companions.generated';
import { useCall } from './useCall';
import MemoryLibrary from './memories/MemoryLibrary';
import DreamLog from './memories/DreamLog';
import TopicLog from './memories/TopicLog';
import SettingsPanel from './settings/SettingsPanel';

const getServer = () => process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3001';

type Mem = { id: string; kind: string; content: string; createdAt: string };

const KIND_LABEL: Record<string, string> = {
  fact: '事实', state: '近况', preference: '偏好', episodic: '情节', profile: '特质', constraint: '约束',
};
// 笔记本展示的类型（含约束）
const SHOW_KINDS = ['constraint', 'fact', 'state', 'preference', 'episodic', 'profile'];
const chipClass = (k: string) => k;

const CallIcon = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
  </svg>
);

// 笔记本头部三个功能入口的图标（Feather 风格线性图标，跟随 currentColor）。
const DreamIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const TopicIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const BookIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  </svg>
);

export default function Page() {
  const [added, setAdded] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
  const [dreamOpen, setDreamOpen] = useState(false);
  const [topicOpen, setTopicOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isElectron, setIsElectron] = useState(false);
  const [keysMissing, setKeysMissing] = useState(false);

  const [inCall, setInCall] = useState(false);
  const [callStartAt, setCallStartAt] = useState<string | null>(null);
  const [memories, setMemories] = useState<Mem[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [contactsLoading, setContactsLoading] = useState(true);
  // 启动遮罩：通讯录加载完成后淡出揭开
  const [bootVisible, setBootVisible] = useState(true);
  const [bootFading, setBootFading] = useState(false);
  // 笔记本侧栏的行内编辑 / 删除二次确认（Electron 不支持 prompt/confirm）
  const [editingMem, setEditingMem] = useState<{ id: string; text: string } | null>(null);
  const [deletingMem, setDeletingMem] = useState<string | null>(null);

  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const call = useCall(getServer);

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
        // 默认选中第一个人物（列表顺序第一个）
        const firstName = COMPANIONS.find((c) => m[c.name])?.name;
        if (firstName) setSelected((prev) => prev ?? firstName);
        setContactsLoading(false);
        setBootFading(true);
        setTimeout(() => setBootVisible(false), 700);
      } catch {
        if (cancelled) return;
        if (attempt < 20) timer = setTimeout(() => load(attempt + 1), 500);
        else {
          setContactsLoading(false); // 重试耗尽，结束 loading
          setBootFading(true);
          setTimeout(() => setBootVisible(false), 700);
        }
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
  }, [call.transcript]);

  const showNotice = (msg: string) => {
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 4000);
  };

  // 后端推送的提示（如「额度不足」）走同一套 toast。
  useEffect(() => {
    if (call.notice) showNotice(call.notice);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.notice]);

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
    setMemoriesLoading(true);
    const url = `${getServer()}/memories?persona=${encodeURIComponent(selected)}${since ? '&since=' + encodeURIComponent(since) : ''}`;
    try {
      const r = await fetch(url);
      if (!r.ok) return;
      const d = await r.json();
      setMemories((d.memories ?? []).filter((m: Mem) => SHOW_KINDS.includes(m.kind)));
    } catch { /* 后端未起，忽略 */ } finally {
      setMemoriesLoading(false);
    }
  }

  // 通话开始时拉一次记忆；之后的更新由后端「记忆写好」事件驱动（见 call.start 的 onMemory）。
  useEffect(() => {
    if (inCall && callStartAt) {
      loadMemories(callStartAt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCall, callStartAt, selected]);

  function select(name: string) {
    if (inCall) return;
    setSelected(name);
    setCallStartAt(null);
    setMemories([]);
  }

  function startCall(c: Companion) {
    if (!c.available) return;
    const startAt = new Date().toISOString();
    setSelected(c.name);
    setMemories([]);
    setCallStartAt(startAt);
    setInCall(true);
    setNotice(null);
    call.start(c.name, (reason) => {
      setInCall(false);
      if (reason === 'disconnect') showNotice('连接已断开，对方不在线了');
    }, () => loadMemories(startAt));
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

  async function saveEditMem() {
    if (!editingMem || !editingMem.text.trim()) { setEditingMem(null); return; }
    try {
      await fetch(`${getServer()}/memories/${editingMem.id}?persona=${encodeURIComponent(selected ?? '')}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editingMem.text.trim() }),
      });
      setEditingMem(null);
      loadMemories(inCall ? callStartAt : null);
    } catch (e) { console.error('编辑记忆失败：', e); }
  }

  async function doDeleteMem(m: Mem) {
    try {
      await fetch(`${getServer()}/memories/${m.id}?persona=${encodeURIComponent(selected ?? '')}`, { method: 'DELETE' });
      setDeletingMem(null);
      loadMemories(inCall ? callStartAt : null);
    } catch (e) { console.error('删除记忆失败：', e); }
  }

  // 头像缩写：中文名取后两个字（略去姓氏，如「程书衡」→「书衡」）。
  const avatarText = (c: Companion) => c.name.slice(1);
  const addedList = COMPANIONS.filter((c) => added[c.name]);
  const filtered = addedList.filter((c) => c.name.includes(query) || c.temperament.includes(query));

  return (
    <>
      {bootVisible && (
        <div className={`boot-overlay${bootFading ? ' boot-fading' : ''}`}>
          <div className="boot-pool bp1" /><div className="boot-pool bp2" /><div className="boot-pool bp3" /><div className="boot-pool bp4" /><div className="boot-pool bp5" />
          <div className="boot-grain" />
        </div>
      )}
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
            {contactsLoading ? (
              <div className="empty">加载中…</div>
            ) : addedList.length === 0 ? (
              <div className="empty">还没有伙伴<br />点右上角 ＋ 添加</div>
            ) : filtered.length === 0 ? (
              <div className="empty">没有找到匹配的伙伴</div>
            ) : (
              filtered.map((c) => (
                <div className={`c${selected === c.name ? ' active' : ''}`} key={c.name} onClick={() => select(c.name)}>
                  <div className="avatar" style={{ background: c.color }}>{avatarText(c)}<span className={`dot ${c.available ? 'on' : 'off'}`} /></div>
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
                  <div className="avatar big" style={{ background: selectedCompanion.color }}>{avatarText(selectedCompanion)}</div>
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
                <div className="avatar" style={{ background: selectedCompanion.color }}>{avatarText(selectedCompanion)}</div>
                <div>
                  <div className="name">{selectedCompanion.name}</div>
                  <div className="status">{call.status || selectedCompanion.temperament}</div>
                </div>
                <div className="live"><span className="pulse" />通话中</div>
              </div>
              <div className="transcript" ref={transcriptRef}>
                {call.transcript.length === 0 ? (
                  <div className="transcript-empty">文字记录会出现在这里…</div>
                ) : (
                  call.transcript.map((t, i) => (
                    <div className={`row ${t.role === 'user' ? 'user' : 'ai'}`} key={i}>
                      <div className="bubble">{t.text}</div>
                      <div className="who">{t.role === 'user' ? '我' : selectedCompanion.name}</div>
                    </div>
                  ))
                )}
                {call.agentSpeaking && <div className="speaking"><i /><i /><i />对方正在说…</div>}
              </div>
              <div className="controls">
                <button className={`ctl${call.muted ? ' muted' : ''}`} onClick={call.toggleMute}>{call.muted ? '🎙️ 开麦' : '🎙️ 关麦'}</button>
                <button className="ctl hangup" onClick={call.hangup}>📞 挂断</button>
              </div>
            </>
          )}
        </main>

        {/* 右：笔记本 */}
        <aside className="book glass">
          <div className="book-h">
            <h2>📓 笔记本</h2>
            {selectedCompanion && (
              <div className="book-tools">
                <button className="icon-btn" onClick={() => setDreamOpen(true)} title="做梦" aria-label="做梦"><DreamIcon /></button>
                <button className="icon-btn" onClick={() => setTopicOpen(true)} title="话题" aria-label="话题"><TopicIcon /></button>
                <button className="icon-btn" onClick={() => setLibOpen(true)} title="更多记忆" aria-label="更多记忆"><BookIcon /></button>
              </div>
            )}
          </div>
          <div className="scope">{inCall ? '本次对话产生的记忆' : selectedCompanion ? `${selectedCompanion.name} 记得的（开始通话后显示本次对话）` : '选择一个伙伴'}</div>
          <div className="mem">
            {!selectedCompanion ? (
              <div className="empty">选一位伙伴后<br />这里显示 TA 关于你的记忆</div>
            ) : memoriesLoading && memories.length === 0 ? (
              <div className="empty">加载中…</div>
            ) : memories.length === 0 ? (
              <div className="empty">{inCall ? <>还没产生新记忆<br />聊几句就有了</> : '暂无本次对话的记忆'}</div>
            ) : (
              memories.map((m) => (
                <div className="m" key={m.id}>
                  <div className="mh">
                    <span className={`chip ${chipClass(m.kind)}`}>{KIND_LABEL[m.kind] ?? m.kind}</span>
                    <button className="del" onClick={() => { setEditingMem(null); setDeletingMem(m.id); }} title="删除">✕</button>
                  </div>
                  {editingMem?.id === m.id ? (
                    <>
                      <textarea className="mem-edit-input" value={editingMem.text} autoFocus rows={3} onChange={(e) => setEditingMem({ id: m.id, text: e.target.value })} />
                      <div>
                        <button className="edit" onClick={saveEditMem}>保存</button>
                        <button className="edit" onClick={() => setEditingMem(null)}>取消</button>
                      </div>
                    </>
                  ) : deletingMem === m.id ? (
                    <>
                      <div className="mb">{m.content}</div>
                      <div>
                        <button className="edit" onClick={() => doDeleteMem(m)}>确认删除</button>
                        <button className="edit" onClick={() => setDeletingMem(null)}>取消</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="mb">{m.content}</div>
                      <button className="edit" onClick={() => { setDeletingMem(null); setEditingMem({ id: m.id, text: m.content }); }}>编辑</button>
                    </>
                  )}
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
                  <div className="avatar" style={{ background: c.color }}>{avatarText(c)}<span className={`dot ${c.available ? 'on' : 'off'}`} /></div>
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
        <MemoryLibrary persona={selectedCompanion.name} onClose={() => setLibOpen(false)} />
      )}

      {dreamOpen && selectedCompanion && (
        <DreamLog persona={selectedCompanion.name} onClose={() => setDreamOpen(false)} />
      )}

      {topicOpen && selectedCompanion && (
        <TopicLog persona={selectedCompanion.name} onClose={() => setTopicOpen(false)} />
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      {notice && <div className="toast">{notice}</div>}

      {call.safety && (
        <div className="safety-overlay">
          <div className="safety-card">
            <div className="safety-title">请别一个人扛</div>
            <div className="safety-sub">此刻可以联系这些真人帮助（24 小时）：</div>
            <ul className="safety-list">
              {call.safety.resources.map((r) => (
                <li key={r.number}>
                  <a href={`tel:${r.number}`}>{r.name} {r.number}</a>
                  {r.note ? <span className="safety-note">（{r.note}）</span> : null}
                </li>
              ))}
            </ul>
            <button className="safety-close" onClick={call.dismissSafety}>我知道了</button>
          </div>
        </div>
      )}
    </>
  );
}
