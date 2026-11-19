'use client';

import { Fragment, useEffect, useState } from 'react';

const getServer = () => process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3001';

type Mem = { id: string; kind: string; content: string; createdAt: string };
type Filter = 'all' | 'fact' | 'preference' | 'episodic' | 'profile';

const KIND_LABEL: Record<string, string> = {
  fact: '事实', preference: '偏好', episodic: '情节', profile: '人设', constraint: '约束',
};
const SHOW_KINDS = ['fact', 'preference', 'episodic', 'profile'];
const chipClass = (k: string) => (k === 'profile' ? 'persona' : k);
const TABS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'fact', label: '事实' },
  { key: 'preference', label: '偏好' },
  { key: 'episodic', label: '情节' },
  { key: 'profile', label: '人设' },
];

export default function MemoryLibrary({ character, onClose }: { character: string; onClose: () => void }) {
  const [memories, setMemories] = useState<Mem[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    if (!character) return;
    try {
      const r = await fetch(`${getServer()}/memories?character=${encodeURIComponent(character)}`);
      if (!r.ok) return;
      const d = await r.json();
      setMemories((d.memories ?? []).filter((m: Mem) => SHOW_KINDS.includes(m.kind)));
    } catch { /* 后端未起，忽略 */ }
  }

  useEffect(() => { if (character) load(); }, [character]); // eslint-disable-line react-hooks/exhaustive-deps

  async function edit(m: Mem) {
    const text = prompt('修改这条记忆：', m.content);
    if (text == null || !text.trim()) return;
    await fetch(`${getServer()}/memories/${m.id}?character=${encodeURIComponent(character)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text.trim() }),
    });
    load();
  }

  async function remove(m: Mem) {
    if (!confirm('删除这条记忆？（会从 AI 记忆里移除）')) return;
    await fetch(`${getServer()}/memories/${m.id}?character=${encodeURIComponent(character)}`, { method: 'DELETE' });
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
          <h3>📓 记忆库{character ? ` · ${character}` : ''}</h3>
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
              {shown.length === 0 ? (
                <tr><td className="empty-cell" colSpan={4}>没有记忆</td></tr>
              ) : (
                shown.map((m) => (
                  <Fragment key={m.id}>
                    <tr
                      className={`mem-row${expanded === m.id ? ' open' : ''}`}
                      onClick={() => setExpanded(expanded === m.id ? null : m.id)}
                    >
                      <td className="col-kind"><span className={`chip ${chipClass(m.kind)}`}>{KIND_LABEL[m.kind] ?? m.kind}</span></td>
                      <td className="col-content" title={m.content}>{m.content}</td>
                      <td className="col-date">{m.createdAt.slice(0, 10)}</td>
                      <td className="col-ops">
                        <button className="row-btn" onClick={(e) => { e.stopPropagation(); edit(m); }}>编辑</button>
                        <button className="row-btn danger" onClick={(e) => { e.stopPropagation(); remove(m); }}>删除</button>
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
