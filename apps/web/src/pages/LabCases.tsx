import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Callout } from '../components/Callout';
import { api, errorText } from '../lib/api';
import { fmtDate, fmtTime } from '../lib/format';
import { useSession } from '../lib/session';
import { go } from '../lib/router';
import { LabFlags, LabStatusPill, unitsText, type LabCaseRow } from './LabCasesTab';

type View = 'open' | 'overdue' | 'received' | 'all';
const VIEWS: [View, string, string][] = [
  ['open', 'Open', 'Drafts, cases at the lab and cases back from the lab'],
  ['overdue', 'Overdue', 'At the lab past the date they were due back'],
  ['received', 'Back from lab', 'Ready to seat'],
  ['all', 'All', 'Including seated and cancelled cases'],
];

interface Lab {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
  active: boolean;
}

/**
 * The practice's lab cases at the signed-in person's locations, with the problems worth a call
 * (late from the lab, due after the seat appointment, not back for the appointment), and the
 * list of labs the practice works with.
 */
export function LabCases() {
  const { me } = useSession();
  const tzOf = (locationId: string) => me.locations.find((l) => l.id === locationId)?.time_zone;
  const [view, setView] = useState<View>('open');
  const list = useQuery({ queryKey: ['lab-cases', 'list', view], queryFn: () => api.get<LabCaseRow[]>(`/lab-cases?view=${view}`) });
  const rows = list.data ?? [];
  const problems = rows.filter((r) => r.flags.length > 0).length;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <section className="panel">
        <div className="row spread">
          <h1>Lab cases</h1>
          <div className="chips" role="group" aria-label="Show">
            {VIEWS.map(([key, label, hint]) => (
              <button key={key} type="button" className="chip lab-view" aria-pressed={view === key} title={hint} onClick={() => setView(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="hint" style={{ margin: 0 }}>{VIEWS.find(([k]) => k === view)![2]}.</p>
        {list.error && <Callout>{errorText(list.error)}</Callout>}
        {list.data && rows.length === 0 && <p className="muted">Nothing here.</p>}
        {problems > 0 && (
          <p className="small" aria-live="polite">
            <span aria-hidden="true">⚠ </span>
            {problems} case{problems === 1 ? ' needs' : 's need'} a look.
          </p>
        )}
        {rows.length > 0 && (
          <div className="tablewrap">
            <table className="lab-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Patient</th>
                  <th>Units</th>
                  <th>Lab</th>
                  <th>Status</th>
                  <th>Due back</th>
                  <th>Seat appointment</th>
                  <th>Needs a look</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`clickable${r.flags.length ? ' has-flag' : ''}`} onClick={() => go(`/patients/${r.patient_id}/lab`)}>
                    <td className="mono nowrap">{r.case_number}</td>
                    <td>
                      <a href={`#/patients/${r.patient_id}/lab`} onClick={(e) => e.stopPropagation()}>
                        {r.patient_name}
                      </a>
                    </td>
                    <td>{unitsText(r.units)}</td>
                    <td>{r.lab_name}</td>
                    <td>
                      <LabStatusPill status={r.status} round={r.round} />
                    </td>
                    <td>{r.due_date ? fmtDate(r.due_date) : <span className="muted">Not set</span>}</td>
                    <td>
                      {r.appointment_start ? (
                        <>
                          {fmtDate(r.appointment_start)}
                          <span className="cellsub">{fmtTime(r.appointment_start, tzOf(r.location_id))}</span>
                        </>
                      ) : (
                        <span className="muted">Not booked</span>
                      )}
                    </td>
                    <td>
                      <LabFlags flags={r.flags} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Labs />
    </div>
  );
}

function Labs() {
  const qc = useQueryClient();
  const labs = useQuery({ queryKey: ['labs'], queryFn: () => api.get<Lab[]>('/labs') });
  const [editing, setEditing] = useState<Lab | 'new' | null>(null);
  return (
    <section className="panel">
      <div className="row spread">
        <h2>Labs</h2>
        {!editing && (
          <button className="btn small" onClick={() => setEditing('new')}>
            Add a lab
          </button>
        )}
      </div>
      {labs.error && <Callout>{errorText(labs.error)}</Callout>}
      {labs.data?.length === 0 && <p className="muted">No labs yet. Add the labs the practice sends work to.</p>}
      <ul className="entries">
        {labs.data?.map((l) => (
          <li key={l.id} className="entry" style={{ gridTemplateColumns: '1fr auto' }}>
            <div>
              <div className="title">
                {l.name} {!l.active && <span className="pill open">Inactive</span>}
              </div>
              <div className="sub small muted">{[l.phone, l.email, l.address].filter(Boolean).join(' · ')}</div>
            </div>
            <button className="btn small" onClick={() => setEditing(l)}>
              Edit
            </button>
          </li>
        ))}
      </ul>
      {editing && (
        <LabForm
          lab={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ['labs'] });
            qc.invalidateQueries({ queryKey: ['lab-case-reference'] });
          }}
        />
      )}
    </section>
  );
}

function LabForm({ lab, onDone }: { lab: Lab | null; onDone: () => void }) {
  const [f, setF] = useState({ name: lab?.name ?? '', phone: lab?.phone ?? '', email: lab?.email ?? '', address: lab?.address ?? '', note: lab?.note ?? '', active: lab?.active ?? true });
  const save = useMutation({ mutationFn: () => api.post(lab ? `/labs/${lab.id}` : '/labs', f), onSuccess: onDone });
  const input = (key: 'name' | 'phone' | 'email' | 'address' | 'note', label: string, type = 'text') => (
    <label className="field">
      <span className="lbl">{label}</span>
      <input type={type} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} required={key === 'name'} />
    </label>
  );
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3>{lab ? `Edit ${lab.name}` : 'New lab'}</h3>
      <div className="grid2">
        {input('name', 'Name')}
        {input('phone', 'Phone', 'tel')}
        {input('email', 'Email', 'email')}
        {input('address', 'Address')}
      </div>
      {input('note', 'Note')}
      <label className="checks">
        <span>
          <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active (offered on new cases)
        </span>
      </label>
      {save.error && <Callout>{errorText(save.error)}</Callout>}
      <div className="row">
        <button className="btn primary" disabled={save.isPending}>
          Save lab
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
