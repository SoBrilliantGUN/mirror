'use client';

import { Fragment, useEffect, useState } from 'react';

const getServer = () => process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3001';

type Mem = { id: string; kind: string; content: string; createdAt: string };
type Filter = 'all' | 'constraint' | 'fact' | 'state' | 'preference' | 'episodic' | 'profile';

const KIND_LABEL: Record<string, string> = {
  fact: '事实', state: '近况', preference: '偏好', episodic: '情节', profile: '特质', constraint: '约束',
};
const SHOW_KINDS = ['constraint', 'fact', 'state', 'preference', 'episodic', 'profile'];
const chipClass = (k: string) => k;
const TABS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'constraint', label: '约束' },
  { key: 'fact', label: '事实' },
  { key: 'state', label: '近况' },
  { key: 'preference', label: '偏好' },
  { key: 'episodic', label: '情节' },
  { key: 'profile', label: '特质' },
];

export default function MemoryLibrary({ persona, onClose }: { persona: string; onClose: () => void }) {
  const [memories, setMemories] = useState<Mem[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  // 行内编辑状态：Electron 里 window.prompt() 不被支持，改用表格内 textarea 就地编辑。
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  // 删除二次确认：Electron 的 confirm() 已弃用，改成「删除 → 确认删除」两步，不依赖原生弹窗。
  const [deleting, setDeleting] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    if (!persona) return;
    setLoading(true);
    try {
      const r = await fetch(`${getServer()}/memories?persona=${encodeURIComponent(persona)}`);
      if (!r.ok) return;
      const d = await r.json();
      setMemories((d.memories ?? []).filter((m: Mem) => SHOW_KINDS.includes(m.kind)));
    } catch { /* 后端未起，忽略 */ } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (persona) load(); }, [persona]); // eslint-disable-line react-hooks/exhaustive-deps

  function startEdit(m: Mem) {
    setExpanded(null); // 收起展开行，别跟编辑框抢空间
    setDeleting(null);
    setEditing({ id: m.id, text: m.content });
  }

  async function saveEdit() {
    if (!editing || !editing.text.trim()) { setEditing(null); return; }
    await fetch(`${getServer()}/memories/${editing.id}?persona=${encodeURIComponent(persona)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: editing.text.trim() }),
    });
    setEditing(null);
    load();
  }

  function startDelete(id: string) {
    setExpanded(null);
    setEditing(null);
    setDeleting(id);
  }

  async function remove(m: Mem) {
    await fetch(`${getServer()}/memories/${m.id}?persona=${encodeURIComponent(persona)}`, { method: 'DELETE' });
    setDeleting(null);
    load();
  }

  const shown = memories.filter((m) => {
    if (filter === 'profile') { if (m.kind !== 'profile') return false; }
    else if (filter !== 'all') { if (m.kind !== filter) return false; }
    if (q.trim() && !m.content.includes(q.trim())) return false;
    return true;
  });

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel lib-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-h">
          <h3>📓 记忆库{persona ? ` · ${persona}` : ''}</h3>
          <button className="panel-close" onClick={onClose}>✕</button>
        </div>
        <div className="lib-tools">
          <div className="lib-search"><span>🔍</span><input placeholder="搜索记忆内容" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t.key} className={`tab${filter === t.key ? ' active' : ''}`} data-k={t.key} onClick={() => setFilter(t.key)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div className="lib-sub">共 {shown.length} 条（这里的删改会直接生效到 AI 记忆）</div>
        <div className="lib-table-wrap">
          <table className="mem-table">
            <thead>
              <tr>
                <th className="col-kind">类型</th>
                <th className="col-content">内容</th>
                <th className="col-date">时间</th>
                <th className="col-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td className="empty-cell" colSpan={4}>加载中…</td></tr>
              ) : shown.length === 0 ? (
                <tr><td className="empty-cell" colSpan={4}>没有记忆</td></tr>
              ) : (
                shown.map((m) => (
                  <Fragment key={m.id}>
                    <tr
                      className={`mem-row${expanded === m.id ? ' open' : ''}`}
                      onClick={() => { if (editing?.id !== m.id) setExpanded(expanded === m.id ? null : m.id); }}
                    >
                      <td className="col-kind"><span className={`chip ${chipClass(m.kind)}`}>{KIND_LABEL[m.kind] ?? m.kind}</span></td>
                      <td className="col-content" title={m.content}>
                        {editing?.id === m.id ? (
                          <textarea
                            className="mem-edit-input"
                            value={editing.text}
                            autoFocus
                            rows={3}
                            onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                          />
                        ) : (
                          m.content
                        )}
                      </td>
                      <td className="col-date">{m.createdAt.slice(0, 10)}</td>
                      <td className="col-ops">
                        {editing?.id === m.id ? (
                          <>
                            <button className="row-btn" onClick={(e) => { e.stopPropagation(); saveEdit(); }}>保存</button>
                            <button className="row-btn danger" onClick={(e) => { e.stopPropagation(); setEditing(null); }}>取消</button>
                          </>
                        ) : deleting === m.id ? (
                          <>
                            <button className="row-btn danger" onClick={(e) => { e.stopPropagation(); remove(m); }}>确认删除</button>
                            <button className="row-btn" onClick={(e) => { e.stopPropagation(); setDeleting(null); }}>取消</button>
                          </>
                        ) : (
                          <>
                            <button className="row-btn" onClick={(e) => { e.stopPropagation(); startEdit(m); }}>编辑</button>
                            <button className="row-btn danger" onClick={(e) => { e.stopPropagation(); startDelete(m.id); }}>删除</button>
                          </>
                        )}
                      </td>
                    </tr>
                    {expanded === m.id && (
                      <tr className="expand-row" onClick={() => setExpanded(null)}>
                        <td colSpan={4}><div className="expand-full">{m.content}</div></td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
