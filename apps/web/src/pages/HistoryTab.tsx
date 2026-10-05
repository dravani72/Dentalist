import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, errorText } from '../lib/api';
import { fmtStamp } from '../lib/format';
import { useSession } from '../lib/session';
import type { PatientDetail } from '../lib/types';

type Kind = 'allergies' | 'medications' | 'conditions';

/**
 * Medical history is versioned: a correction adds a new row that supersedes the old one, so
 * the prior value stays visible in the record and the audit log.
 */
export function HistoryTab({ patientId, d }: { patientId: string; d: PatientDetail }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['patient', patientId] });
  const review = useMutation({ mutationFn: () => api.post(`/patients/${patientId}/history-review`, {}), onSuccess: refresh });
  const retire = useMutation({
    mutationFn: (v: { kind: Kind; id: string; status: 'inactive' | 'entered_in_error' }) =>
      api.post(`/patients/${patientId}/history/${v.kind}/${v.id}/revise`, { status: v.status }),
    onSuccess: refresh,
  });
  const editable = can('medical_history.record');
  const section = (kind: Kind, title: string, rows: { id: string; label: string; sub: string }[]) => (
    <section className="panel">
      <h2>{title}</h2>
      {rows.length === 0 && <p className="muted">None recorded.</p>}
      <ul className="entries">
        {rows.map((r) => (
          <li key={r.id} className="entry" style={{ gridTemplateColumns: '1fr auto' }}>
            <div>
              <div className="title">{r.label}</div>
              <div className="sub">{r.sub}</div>
            </div>
            {editable && (
              <div className="row">
                <button className="btn small" onClick={() => retire.mutate({ kind, id: r.id, status: 'inactive' })}>
                  No longer active
                </button>
                <button className="btn small" onClick={() => retire.mutate({ kind, id: r.id, status: 'entered_in_error' })}>
                  Entered in error
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editable && <AddHistory patientId={patientId} kind={kind} onDone={refresh} />}
    </section>
  );
  return (
    <>
      <div className="row spread">
        <span className="muted">
          {d.lastHistoryReview ? `Last reviewed ${fmtStamp(d.lastHistoryReview.reviewed_at)} by ${d.lastHistoryReview.reviewed_by_name}` : 'Not yet reviewed'}
        </span>
        {editable && (
          <button className="btn primary" onClick={() => review.mutate()} disabled={review.isPending}>
            Mark history reviewed today
          </button>
        )}
      </div>
      {(review.error || retire.error) && <div className="err">{errorText(review.error ?? retire.error)}</div>}
      <div className="grid2">
        {section(
          'allergies',
          'Allergies',
          d.allergies.map((a) => ({ id: a.id, label: `⚠ ${a.substance}`, sub: [a.reaction, a.severity, `confirmed ${fmtStamp(a.last_confirmed_at)} by ${a.recorded_by_name}`].filter(Boolean).join(' · ') })),
        )}
        {section(
          'medications',
          'Medications',
          d.medications.map((m) => ({
            id: m.id,
            label: `${m.medication}${m.is_anticoagulant ? ' (anticoagulant)' : ''}`,
            sub: [m.dose, m.frequency, `confirmed ${fmtStamp(m.last_confirmed_at)}`].filter(Boolean).join(' · '),
          })),
        )}
        {section(
          'conditions',
          'Conditions',
          d.conditions.map((c) => ({ id: c.id, label: c.condition, sub: `confirmed ${fmtStamp(c.last_confirmed_at)}` })),
        )}
      </div>
    </>
  );
}

function AddHistory({ patientId, kind, onDone }: { patientId: string; kind: Kind; onDone(): void }) {
  const [text, setText] = useState('');
  const [extra, setExtra] = useState('');
  const [severity, setSeverity] = useState('moderate');
  const [anticoag, setAnticoag] = useState(false);
  const add = useMutation({
    mutationFn: () => {
      const source = 'patient_reported';
      const body =
        kind === 'allergies'
          ? { substance: text, reaction: extra || undefined, severity, source }
          : kind === 'medications'
            ? { medication: text, dose: extra || undefined, isAnticoagulant: anticoag, source }
            : { condition: text, note: extra || undefined, source };
      return api.post(`/patients/${patientId}/history/${kind}`, body);
    },
    onSuccess: () => {
      setText('');
      setExtra('');
      onDone();
    },
  });
  const id = `add-${kind}`;
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <input id={id} type="text" aria-label={`Add ${kind}`} placeholder={kind === 'allergies' ? 'Substance' : kind === 'medications' ? 'Medication' : 'Condition'} value={text} onChange={(e) => setText(e.target.value)} required style={{ flex: '1 1 140px', width: 'auto' }} />
      <input type="text" aria-label="Detail" placeholder={kind === 'allergies' ? 'Reaction' : kind === 'medications' ? 'Dose' : 'Note'} value={extra} onChange={(e) => setExtra(e.target.value)} style={{ flex: '1 1 100px', width: 'auto' }} />
      {kind === 'allergies' && (
        <select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)} style={{ width: 'auto' }}>
          {['mild', 'moderate', 'severe', 'unknown'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      )}
      {kind === 'medications' && (
        <label className="small">
          <input type="checkbox" checked={anticoag} onChange={(e) => setAnticoag(e.target.checked)} /> Anticoagulant
        </label>
      )}
      <button className="btn small">Add</button>
      {add.error && <div className="err">{errorText(add.error)}</div>}
    </form>
  );
}
