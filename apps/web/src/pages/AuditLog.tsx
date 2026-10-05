import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, errorText } from '../lib/api';
import { fmtStamp } from '../lib/format';

interface Row {
  seq: string;
  occurred_at: string;
  action: string;
  object_type: string | null;
  object_id: string | null;
  outcome: string;
  purpose: string;
  actor_name: string | null;
}

/** Compliance view of the hash-chained audit log for this practice. */
export function AuditLog() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [action, setAction] = useState('');
  const q = useQuery({
    queryKey: ['audit', from, to, action],
    queryFn: () => {
      const qs = new URLSearchParams({ from: new Date(`${from}T00:00:00`).toISOString(), to: new Date(`${to}T23:59:59`).toISOString() });
      if (action) qs.set('action', action);
      return api.get<Row[]>(`/audit/events?${qs}`);
    },
  });
  return (
    <>
      <h1>Audit log</h1>
      <div className="row">
        <label className="small">
          From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 'auto' }} />
        </label>
        <label className="small">
          To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 'auto' }} />
        </label>
        <input type="search" aria-label="Action" placeholder="Action, e.g. encounter.sign" value={action} onChange={(e) => setAction(e.target.value)} style={{ width: 240 }} />
      </div>
      {q.error && <div className="err">{errorText(q.error)}</div>}
      <section className="panel">
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th>Object</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.map((r) => (
                <tr key={r.seq}>
                  <td className="mono">{r.seq}</td>
                  <td className="mono">{fmtStamp(r.occurred_at)}</td>
                  <td>{r.actor_name ?? 'System'}</td>
                  <td>{r.action}</td>
                  <td className="mono small">{r.object_type ? `${r.object_type} ${r.object_id?.slice(0, 8) ?? ''}` : ''}</td>
                  <td>{r.outcome === 'success' ? '✓ allowed' : `✕ ${r.outcome}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
