import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, errorText } from '../lib/api';
import { ageFrom, fmtDate, patientName } from '../lib/format';
import { go } from '../lib/router';
import { useSession } from '../lib/session';
import type { PatientRow } from '../lib/types';

export function Patients() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const term = q.trim();
  const results = useQuery({
    queryKey: ['patients', term],
    queryFn: () => api.get<PatientRow[]>(`/patients?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2,
  });
  return (
    <>
      <div className="row spread">
        <h1>Patients</h1>
        {can('patient.write_demographics') && (
          <button className="btn" onClick={() => setCreating((c) => !c)}>
            {creating ? 'Close' : 'New patient'}
          </button>
        )}
      </div>
      {creating && <NewPatient />}
      <section className="panel">
        <div className="field">
          <label htmlFor="psearch">Search by name, chart number or date of birth</label>
          <input id="psearch" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="At least 2 characters" autoFocus />
        </div>
        {results.error && <div className="err">{errorText(results.error)}</div>}
        {results.data && results.data.length === 0 && <p className="muted">No matching patients.</p>}
        {results.data && results.data.length > 0 && (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Chart</th>
                  <th>Date of birth</th>
                </tr>
              </thead>
              <tbody>
                {results.data.map((p) => (
                  <tr key={p.id} className="clickable" onClick={() => go(`/patients/${p.id}`)}>
                    <td>
                      <a href={`#/patients/${p.id}`}>{patientName(p)}</a>
                    </td>
                    <td className="mono">{p.chart_number}</td>
                    <td>
                      {fmtDate(p.date_of_birth)} ({ageFrom(p.date_of_birth)})
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function NewPatient() {
  const { me } = useSession();
  const [f, setF] = useState({ legalGivenName: '', legalFamilyName: '', preferredName: '', dateOfBirth: '', sexAtBirth: 'unknown', email: '', phone: '', homeLocationId: me.locations[0]?.id ?? '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/patients', {
        ...f,
        preferredName: f.preferredName || undefined,
        email: f.email || undefined,
        phone: f.phone || undefined,
      }),
    onSuccess: (r) => go(`/patients/${r.id}`),
  });
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <h2>New patient</h2>
      <p className="hint">Synthetic data only. Use made-up names and dates.</p>
      <div className="grid2">
        <div className="field">
          <label htmlFor="np-given">Legal first name</label>
          <input id="np-given" type="text" value={f.legalGivenName} onChange={set('legalGivenName')} required />
        </div>
        <div className="field">
          <label htmlFor="np-family">Legal last name</label>
          <input id="np-family" type="text" value={f.legalFamilyName} onChange={set('legalFamilyName')} required />
        </div>
        <div className="field">
          <label htmlFor="np-pref">Preferred name</label>
          <input id="np-pref" type="text" value={f.preferredName} onChange={set('preferredName')} />
        </div>
        <div className="field">
          <label htmlFor="np-dob">Date of birth</label>
          <input id="np-dob" type="date" value={f.dateOfBirth} onChange={set('dateOfBirth')} required />
        </div>
        <div className="field">
          <label htmlFor="np-sex">Sex at birth</label>
          <select id="np-sex" value={f.sexAtBirth} onChange={set('sexAtBirth')}>
            {['unknown', 'female', 'male', 'intersex'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="np-loc">Home location</label>
          <select id="np-loc" value={f.homeLocationId} onChange={set('homeLocationId')}>
            {me.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="np-email">Email</label>
          <input id="np-email" type="email" value={f.email} onChange={set('email')} />
        </div>
        <div className="field">
          <label htmlFor="np-phone">Phone</label>
          <input id="np-phone" type="text" value={f.phone} onChange={set('phone')} />
        </div>
      </div>
      {create.error && <div className="err">{errorText(create.error)}</div>}
      <div>
        <button className="btn primary" disabled={create.isPending}>
          Create patient
        </button>
      </div>
    </form>
  );
}
