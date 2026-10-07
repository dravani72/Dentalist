import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, errorText } from '../lib/api';
import { ageFrom, fmtDate, fmtTime, patientName } from '../lib/format';
import { go } from '../lib/router';
import { useSession } from '../lib/session';
import type { PatientRow, Staff } from '../lib/types';
import { daysBetween, formatCents, imagingLabel, readStatus, specimenStatus, SPECIMEN_STATUS_LABELS } from '@teeth/shared';
import { ReadPill } from './ImagingTab';

interface PatientListRow extends PatientRow {
  recall_due: string | null;
  recall_type: string | null;
  recall_interval_months: number | null;
  next_appointment_at: string | null;
  last_visit_at: string | null;
  open_treatment: number;
  unscheduled_treatment: number;
  patient_due_cents?: number;
}

type FilterKey = 'recall' | 'appointment' | 'treatment' | 'providerId' | 'age' | 'balance';
type Filters = Record<FilterKey, string>;
const NO_FILTERS: Filters = { recall: '', appointment: '', treatment: '', providerId: '', age: '', balance: '' };
const LIST_LIMIT = 200;
// Filter choices only (never the search text) are kept for the tab, so they survive opening a chart.
const FILTER_KEY = 'teeth.patientFilters';

function savedFilters(): Filters {
  try {
    return { ...NO_FILTERS, ...(JSON.parse(sessionStorage.getItem(FILTER_KEY) ?? '{}') as Partial<Filters>) };
  } catch {
    return NO_FILTERS;
  }
}

export function Patients() {
  const { me, can } = useSession();
  const [q, setQ] = useState('');
  const [filters, setFiltersState] = useState<Filters>(savedFilters);
  const [creating, setCreating] = useState(false);
  const setFilters = (f: Filters) => {
    setFiltersState(f);
    try {
      sessionStorage.setItem(FILTER_KEY, JSON.stringify(f));
    } catch {
      /* storage unavailable: filters just won't persist */
    }
  };
  const set = (k: FilterKey) => (e: React.ChangeEvent<HTMLSelectElement>) => setFilters({ ...filters, [k]: e.target.value });
  const term = q.trim();
  const filtering = Object.values(filters).some(Boolean);
  const params = new URLSearchParams({ q: term, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) });
  const results = useQuery({
    queryKey: ['patients', params.toString()],
    queryFn: () => api.get<PatientListRow[]>(`/patients?${params}`),
    enabled: term.length >= 2 || filtering,
  });
  const providers = useQuery({
    queryKey: ['patient-filter-providers', me.locations.map((l) => l.id).join()],
    queryFn: async () => {
      const refs = await Promise.all(me.locations.map((l) => api.get<{ providers: Staff[] }>(`/locations/${l.id}/schedule-reference`)));
      const byId = new Map(refs.flatMap((r) => r.providers).map((p) => [p.id, p]));
      return [...byId.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
    },
    enabled: can('schedule.read'),
    staleTime: 5 * 60_000,
  });
  const showBalance = can('billing.read');
  const tzOf = (locationId: string) => me.locations.find((l) => l.id === locationId)?.time_zone;
  const field = (k: FilterKey, label: string, options: [string, string][]) => (
    <div className={`field${filters[k] ? ' active' : ''}`}>
      <label htmlFor={`pf-${k}`}>{label}</label>
      <select id={`pf-${k}`} value={filters[k]} onChange={set(k)}>
        <option value="">Any</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <>
      <div className="row spread">
        <h1>Patients</h1>
        <div className="row">
          <button className="btn" aria-pressed={filters.recall === 'active'} onClick={() => setFilters({ ...NO_FILTERS, recall: 'active' })}>
            Recall list
          </button>
          {can('patient.write_demographics') && (
            <button className="btn" onClick={() => setCreating((c) => !c)}>
              {creating ? 'Close' : 'New patient'}
            </button>
          )}
        </div>
      </div>
      {creating && <NewPatient />}
      {can('clinical_finding.record') && <BiopsyWorklist />}
      {can('clinical_finding.record') && <ImagingWorklist />}
      <section className="panel">
        <div className="field">
          <label htmlFor="psearch">Search by name, chart number or date of birth</label>
          <input id="psearch" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="At least 2 characters, or choose a filter below" autoFocus />
        </div>
        <div className="filters" role="group" aria-label="Filters">
          {field('recall', 'Recall', [
            ['active', 'In recall'],
            ['overdue', 'Overdue'],
            ['due_30', 'Due in the next 30 days'],
          ])}
          {field('appointment', 'Next appointment', [
            ['booked', 'Booked'],
            ['none', 'Not booked'],
          ])}
          {field('treatment', 'Treatment plan', [
            ['open', 'Any unfinished treatment'],
            ['unscheduled', 'Accepted, not scheduled'],
          ])}
          {can('schedule.read') && field('providerId', 'Provider', (providers.data ?? []).map((p) => [p.id, p.display_name]))}
          {field('age', 'Age group', [
            ['child', 'Under 18'],
            ['adult', '18 to 64'],
            ['senior', '65 and over'],
          ])}
          {showBalance && field('balance', 'Balance', [['owes', 'Owes a balance']])}
          {filtering && (
            <div>
              <button className="btn small" onClick={() => setFilters(NO_FILTERS)}>
                Clear filters
              </button>
            </div>
          )}
        </div>
        {filters.recall && (
          <p className="hint">
            In recall means a patient with a recall due date (set automatically when a cleaning or periodic exam is signed) or treatment that is planned but not yet done.
            Sorted by recall due date, most overdue first.
          </p>
        )}
        {results.error && <div className="err">{errorText(results.error)}</div>}
        {results.data && results.data.length === 0 && <p className="muted">No matching patients.</p>}
        {results.data && results.data.length > 0 && (
          <>
            <p className="small muted" aria-live="polite">
              {results.data.length >= LIST_LIMIT ? `Showing the first ${LIST_LIMIT} patients. Add a filter or search to narrow the list.` : `${results.data.length} patient${results.data.length === 1 ? '' : 's'}`}
            </p>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Chart</th>
                    <th>Date of birth</th>
                    <th>Recall</th>
                    <th>Next appointment</th>
                    <th>Last visit</th>
                    <th>Treatment</th>
                    {showBalance && <th>Patient owes</th>}
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
                      <td>
                        <RecallCell row={p} />
                      </td>
                      <td>
                        {p.next_appointment_at ? (
                          <>
                            ✓ {fmtDate(p.next_appointment_at)}
                            <span className="cellsub">{fmtTime(p.next_appointment_at, tzOf(p.home_location_id))}</span>
                          </>
                        ) : (
                          <span className="muted">— Not booked</span>
                        )}
                      </td>
                      <td>{p.last_visit_at ? fmtDate(p.last_visit_at) : <span className="muted">—</span>}</td>
                      <td>
                        {p.open_treatment > 0 ? (
                          <>
                            {p.open_treatment} open
                            {p.unscheduled_treatment > 0 && <span className="cellsub">{p.unscheduled_treatment} accepted, not scheduled</span>}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      {showBalance && <td className="mono">{p.patient_due_cents && p.patient_due_cents > 0 ? formatCents(p.patient_due_cents) : <span className="muted">—</span>}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}

/** Recall due date with its state as icon + word + border style (never color alone). */
function RecallCell({ row }: { row: PatientListRow }) {
  if (!row.recall_due) return <span className="muted">— None set</span>;
  const days = Math.round((new Date(`${row.recall_due}T12:00:00`).getTime() - Date.now()) / 86_400_000);
  const [cls, icon, word] = days < 0 ? ['overdue', '⚠', 'Overdue'] : days <= 30 ? ['soon', '◷', 'Due soon'] : ['later', '○', 'Due'];
  return (
    <>
      <span className={`pill ${cls}`}>
        <span aria-hidden="true">{icon}</span> {word}
      </span>
      <span className="cellsub">
        {fmtDate(row.recall_due)}
        {row.recall_interval_months ? ` · every ${row.recall_interval_months} mo` : ''}
      </span>
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

interface AwaitingSpecimen {
  specimen_id: string;
  patient_id: string;
  patient_name: string;
  site: string;
  lab_name: string;
  collected_at: string;
}

/**
 * Biopsies still waiting for a pathology result at this practice, oldest first. Shown only when
 * there are some, so a lost or late report is chased instead of forgotten.
 */
function BiopsyWorklist() {
  const list = useQuery({
    queryKey: ['biopsies-awaiting'],
    queryFn: () => api.get<{ overdueAfterDays: number; specimens: AwaitingSpecimen[] }>('/biopsies/awaiting-results'),
    staleTime: 60_000,
  });
  const rows = list.data?.specimens ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="panel">
      <h2>Biopsy results not back yet ({rows.length})</h2>
      <ul className="biopsy-worklist">
        {rows.map((r) => {
          const status = specimenStatus(r.collected_at, null);
          const days = daysBetween(r.collected_at, new Date());
          return (
            <li key={r.specimen_id}>
              <span className={`pill specimen-status sp-${status}`}>
                <span aria-hidden="true">{status === 'overdue' ? '⚠' : '◷'}</span> {SPECIMEN_STATUS_LABELS[status]}
              </span>{' '}
              <a href={`#/patients/${r.patient_id}/surgery`}>
                {r.patient_name}
              </a>
              : {r.site}, sent {fmtDate(r.collected_at)} to {r.lab_name} ({days} day{days === 1 ? '' : 's'})
            </li>
          );
        })}
      </ul>
      <p className="hint">Results more than {list.data!.overdueAfterDays} days out are marked overdue; call the lab.</p>
    </section>
  );
}

interface UnreadStudy {
  id: string;
  study_id: string;
  patient_id: string;
  patient_name: string;
  modality: string;
  region: string;
  acquired_at: string;
  uploaded_at: string;
}

/**
 * Scans at this practice that no dentist has read yet, oldest first. A CBCT read covers the whole
 * volume, so an unread scan is a finding nobody has looked for. Shown only when there are some.
 */
function ImagingWorklist() {
  const list = useQuery({
    queryKey: ['imaging-unread'],
    queryFn: () => api.get<{ overdueAfterDays: number; studies: UnreadStudy[] }>('/imaging/unread'),
    staleTime: 60_000,
  });
  const rows = list.data?.studies ?? [];
  if (rows.length === 0) return null;
  return (
    <section className="panel">
      <h2>Scans not read yet ({rows.length})</h2>
      <ul className="imaging-worklist">
        {rows.map((r) => {
          const days = daysBetween(r.uploaded_at, new Date());
          return (
            <li key={r.study_id}>
              <ReadPill status={readStatus(r.uploaded_at, false)} />{' '}
              <a href={`#/patients/${r.patient_id}/imaging`}>{r.patient_name}</a>: {imagingLabel(r.modality)}, {imagingLabel(r.region).toLowerCase()}, taken {fmtDate(r.acquired_at)} (
              {days} day{days === 1 ? '' : 's'} waiting)
            </li>
          );
        })}
      </ul>
      <p className="hint">Scans waiting more than {list.data!.overdueAfterDays} days are marked overdue.</p>
    </section>
  );
}
