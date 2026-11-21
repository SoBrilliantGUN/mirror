'use client';

import { useEffect, useState } from 'react';

const getServer = () => process.env.NEXT_PUBLIC_SERVER_URL ?? 'http://localhost:3001';

type DreamDetails = {
  states: string[];
  identity: { field: string; value: string }[];
  profile: string[];
  merged: string[];
  resolved: string[];
};

type DreamRun = {
  details: DreamDetails;
  createdAt: string;
};

// 把一次做梦实际做的事，翻成一行行人话。
function describeDetails(d: DreamDetails): string[] {
  const lines: string[] = [];
  for (const f of d.states) lines.push(`记下近况：${f}`);
  for (const i of d.identity) lines.push(`身份：${i.field} = ${i.value}`);
  for (const p of d.profile) lines.push(`观察到：${p}`);
  for (const m of d.merged) lines.push(`合并了重复：${m}`);
  for (const r of d.resolved) lines.push(`清理了过时：${r}`);
  return lines;
}

export default function DreamLog({ persona, onClose }: { persona: string; onClose: () => void }) {
  const [runs, setRuns] = useState<DreamRun[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!persona) return;
    setLoading(true);
    fetch(`${getServer()}/dream?persona=${encodeURIComponent(persona)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRuns(d?.runs ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [persona]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel lib-panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-h">
          <h3>🌙 做梦记录{persona ? ` · ${persona}` : ''}</h3>
          <button className="panel-close" onClick={onClose}>✕</button>
        </div>
        <div className="lib-sub">空闲时她会自动整理记忆（约每 3 分钟一次），下面是她最近在后台做的事。</div>
        <div className="dream-list">
          {loading ? (
            <div className="empty">加载中…</div>
          ) : runs.length === 0 ? (
            <div className="empty">还没有做梦记录，过一会儿再来看看。</div>
          ) : (
            runs.slice(0, 30).map((r, i) => {
              const lines = describeDetails(r.details ?? { states: [], identity: [], profile: [], merged: [], resolved: [] });
              return (
                <div className="dream-item" key={i}>
                  <div className="dream-item-time">{r.createdAt.slice(0, 16).replace('T', ' ')}</div>
                  <div className="dream-item-body">
                    {lines.length === 0 ? (
                      <div className="dream-line muted">没有新的可巩固内容</div>
                    ) : (
                      lines.map((l, j) => <div className="dream-line" key={j}>{l}</div>)
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
