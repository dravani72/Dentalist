import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IMAGING_MODALITIES,
  IMAGING_READ_OVERDUE_DAYS,
  IMAGING_REGIONS,
  READ_STATUS_LABELS,
  imagingLabel,
  measureMm,
  readStatus,
  type ReadStatus,
} from '@teeth/shared';
import { Callout } from '../components/Callout';
import { VolumeViewer, type Measurement } from '../components/VolumeViewer';
import { ApiError, api, errorText } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useSession } from '../lib/session';
import type { Chart, Entry, ImagingReadEntry, ImagingStudyEntry, PatientDetail, Visit } from '../lib/types';
import { StatusPill } from './ChartTab';

const WRITABLE = ['DRAFT', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'AMENDMENT_REQUIRED', 'AMENDING'];
const live = <T extends Entry>(rows: T[]) => rows.filter((r) => !r.entered_in_error);
/** Read-status marks pair with the written status and a distinct border; the mark is never the only cue. */
const READ_MARK: Record<ReadStatus, string> = { unread: '◷', overdue: '⚠', read: '✓' };

interface Study {
  study: ImagingStudyEntry;
  visit: Visit;
  read: { entry: ImagingReadEntry; visit: Visit } | null;
  status: ReadStatus;
}

export function ReadPill({ status }: { status: ReadStatus }) {
  return (
    <span className={`pill read-status rs-${status}`}>
      <span aria-hidden="true">{READ_MARK[status]}</span> {READ_STATUS_LABELS[status]}
    </span>
  );
}

const mmText = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : `${Number(v)}`);
export function studyTitle(s: ImagingStudyEntry) {
  const teeth = s.teeth?.length ? ` #${s.teeth.join(', #')}` : '';
  return `${imagingLabel(s.modality)}, ${imagingLabel(s.region).toLowerCase()}${teeth}`;
}

/**
 * Diagnostic imaging: the patient's DICOM studies (CBCT volumes and DICOM radiographs), each
 * with its viewer and the dentist's read. A CBCT read covers the whole volume, not only the
 * area the scan was taken for, so unread scans are kept in view until someone reads them.
 */
export function ImagingTab({ patientId, patient }: { patientId: string; patient: PatientDetail }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const chart = useQuery({ queryKey: ['chart', patientId], queryFn: () => api.get<Chart>(`/patients/${patientId}/chart`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['chart', patientId] });
    qc.invalidateQueries({ queryKey: ['imaging-unread'] });
  };
  const visits = chart.data?.visits ?? [];
  const openVisit = visits.find((v) => WRITABLE.includes(v.encounter.status)) ?? null;
  const [openStudy, setOpenStudy] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const studies: Study[] = useMemo(() => {
    const reads = visits.flatMap((visit) => live(visit.entries.imaging_read).map((entry) => ({ entry, visit })));
    return visits.flatMap((visit) =>
      live(visit.entries.imaging_study).map((study) => {
        const read = reads.find((r) => r.entry.study_id === study.study_id) ?? null;
        return { study, visit, read, status: readStatus(visit.encounter.opened_at, !!read) };
      }),
    );
  }, [visits]);

  const startVisit = useMutation({
    mutationFn: () => api.post<{ id: string }>('/encounters', { patientId, locationId: patient.patient.home_location_id, chiefComplaint: 'Imaging' }),
    onSuccess: refresh,
  });

  if (chart.error) return <Callout>{errorText(chart.error)}</Callout>;
  if (!chart.data) return <p>Loading imaging…</p>;
  const unread = studies.filter((s) => s.status !== 'read');
  const shown = openStudy ? studies.find((s) => s.study.study_id === openStudy) ?? null : null;

  return (
    <>
      <section className="panel">
        <div className="row spread">
          <h2>Imaging</h2>
          <div className="row">
            {openVisit && (
              <span className="small">
                Recording in the visit of {fmtDate(openVisit.encounter.opened_at)} <StatusPill status={openVisit.encounter.status} />
              </span>
            )}
            {can('clinical_finding.record') && !openVisit && (
              <button className="btn" onClick={() => startVisit.mutate()} disabled={startVisit.isPending}>
                Start today’s visit
              </button>
            )}
            {can('media.upload') && openVisit && !uploading && (
              <button className="btn primary" onClick={() => setUploading(true)}>
                Upload a DICOM series
              </button>
            )}
          </div>
        </div>
        {startVisit.error && <Callout>{errorText(startVisit.error)}</Callout>}
        {unread.length > 0 && (
          <Callout kind={unread.some((s) => s.status === 'overdue') ? 'error' : 'info'} title={`${unread.length} scan${unread.length > 1 ? 's' : ''} not read yet`}>
            {unread.map((s) => `${studyTitle(s.study)} (${fmtDate(s.visit.encounter.opened_at)})`).join('; ')}. A scan waiting more than {IMAGING_READ_OVERDUE_DAYS} days is marked overdue.
          </Callout>
        )}
        {uploading && openVisit && (
          <UploadForm
            visit={openVisit}
            onDone={(id) => {
              setUploading(false);
              setOpenStudy(id);
              refresh();
            }}
            onCancel={() => setUploading(false)}
          />
        )}
        {studies.length === 0 && <p className="muted">No DICOM studies on file. Plain x-rays and photos are on the Chart tab.</p>}
        {studies.length > 0 && (
          <div className="tablewrap">
            <table className="imaging-table">
              <thead>
                <tr>
                  <th>Study</th>
                  <th>Taken</th>
                  <th>Size</th>
                  <th>Patient identity</th>
                  <th>Read</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {studies.map((s) => (
                  <tr key={s.study.id} className={s.study.study_id === openStudy ? 'selected' : undefined}>
                    <td>
                      {studyTitle(s.study)}
                      {s.study.description && <span className="cellsub">{s.study.description}</span>}
                    </td>
                    <td className="nowrap">
                      {fmtDate(s.study.acquired_at)}
                      <span className="cellsub">
                        visit {fmtDate(s.visit.encounter.opened_at)} <StatusPill status={s.visit.encounter.status} />
                      </span>
                    </td>
                    <td className="nowrap">
                      {s.study.slices > 1 ? `${s.study.columns}×${s.study.rows}×${s.study.slices}` : `${s.study.columns}×${s.study.rows}`}
                      <span className="cellsub">{mmText(s.study.voxel_x_mm)} mm voxels</span>
                    </td>
                    <td>
                      <IdentityLine s={s.study} />
                    </td>
                    <td>
                      <ReadPill status={s.status} />
                    </td>
                    <td>
                      <button className="btn small" aria-pressed={s.study.study_id === openStudy} onClick={() => setOpenStudy(s.study.study_id === openStudy ? null : s.study.study_id)}>
                        {s.study.study_id === openStudy ? 'Close' : 'Open'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">
          <span aria-hidden="true">ⓘ </span>
          The original DICOM files are kept unchanged with a checksum; the viewer works from a copy made for viewing. Compressed DICOM (JPEG, JPEG 2000, RLE) can’t be read yet;
          export uncompressed from the scanner software.
        </p>
      </section>
      {shown && <StudyPanel key={shown.study.id} s={shown} openVisit={openVisit} onChanged={refresh} />}
    </>
  );
}

function IdentityLine({ s }: { s: ImagingStudyEntry }) {
  if (s.patient_match === 'matched') return <span className="small">✓ Matches the chart</span>;
  return (
    <span className="small identity-flag" title={s.identity_confirmation ?? undefined}>
      <span aria-hidden="true">⚠ </span>
      {imagingLabel(s.patient_match)}
    </span>
  );
}

function StudyPanel({ s, openVisit, onChanged }: { s: Study; openVisit: Visit | null; onChanged(): void }) {
  const { can } = useSession();
  const { study, read } = s;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Measurement[]>(read?.entry.measurements ?? []);
  const canRead = can('diagnosis.create') && !!openVisit && (!read || (editing && read.visit === openVisit));
  const measurements = canRead ? draft : read?.entry.measurements ?? [];
  return (
    <section className={`panel study-panel rs-${s.status}`}>
      <div className="row spread">
        <h2>{studyTitle(study)}</h2>
        <ReadPill status={s.status} />
      </div>
      <dl className="implant-facts">
        <Fact label="Taken" value={fmtDate(study.acquired_at)} />
        <Fact label="Device" value={[study.device_manufacturer, study.device_model].filter(Boolean).join(' ') || null} />
        <Fact label="Exposure" value={[study.kvp && `${Number(study.kvp)} kV`, study.tube_current_ma && `${Number(study.tube_current_ma)} mA`, study.exposure_ms && `${(Number(study.exposure_ms) / 1000).toFixed(1)} s`].filter(Boolean).join(', ') || null} />
        <Fact label="Voxels" value={`${mmText(study.voxel_x_mm)} × ${mmText(study.voxel_y_mm)} × ${mmText(study.voxel_z_mm)} mm`} />
        <Fact label="Files" value={`${study.original_sha256s.length} original file${study.original_sha256s.length === 1 ? '' : 's'}, kept unchanged`} />
        <Fact label="Identity" value={study.patient_match === 'matched' ? 'Patient ID or name and birth date match the chart' : `${imagingLabel(study.patient_match)}: “${study.identity_confirmation}”`} />
        <Fact label="Note" value={study.note} />
      </dl>
      {can('media.upload') && s.visit === openVisit && !study.locked_at && <VoidButton route="imaging-studies" entry={study} onChanged={onChanged} />}
      <VolumeViewer study={study} measurements={measurements} onChange={canRead ? setDraft : undefined} />
      <h3>Read</h3>
      {read && !editing && (
        <div className={read.entry.incidental_findings ? 'surgery-problems' : undefined}>
          <p>
            <b>Impression:</b> {read.entry.impression}
          </p>
          <p style={{ whiteSpace: 'pre-wrap' }}>{read.entry.findings}</p>
          <dl className="implant-facts">
            <Fact label="Whole volume reviewed" value={study.slices > 1 ? (read.entry.entire_volume_reviewed ? 'Yes' : 'No') : null} />
            <Fact label="Incidental findings" value={read.entry.incidental_findings ? `▲ Yes: ${read.entry.referral}` : 'None'} />
            <Fact label="Read at" value={`visit of ${fmtDate(read.visit.encounter.opened_at)}`} />
            <Fact label="Note" value={read.entry.note} />
          </dl>
          {can('diagnosis.create') && read.visit === openVisit && (
            <div className="row">
              <button className="btn small" onClick={() => { setDraft(read.entry.measurements); setEditing(true); }}>
                {read.entry.locked_at ? 'Amend read' : 'Edit read'}
              </button>
              {!read.entry.locked_at && <VoidButton route="imaging-reads" entry={read.entry} onChanged={onChanged} />}
            </div>
          )}
          {can('diagnosis.create') && read.visit !== openVisit && <p className="hint">To change this signed read, start an amendment on the visit of {fmtDate(read.visit.encounter.opened_at)} from the Chart tab.</p>}
        </div>
      )}
      {!read && !canRead && <p className="muted">Not read yet.{!can('diagnosis.create') ? ' A dentist reads the scan.' : !openVisit ? ' Start a visit to record the read.' : ''}</p>}
      {canRead && openVisit && (
        <ReadForm
          study={study}
          visit={openVisit}
          existing={editing ? read?.entry : undefined}
          measurements={draft}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
          onCancel={editing ? () => setEditing(false) : undefined}
        />
      )}
    </section>
  );
}

function ReadForm({ study, visit, existing, measurements, onDone, onCancel }: { study: ImagingStudyEntry; visit: Visit; existing?: ImagingReadEntry; measurements: Measurement[]; onDone(): void; onCancel?(): void }) {
  const cbct = study.slices > 1;
  const [f, setF] = useState({
    entireVolumeReviewed: existing?.entire_volume_reviewed ?? false,
    findings: existing?.findings ?? '',
    impression: existing?.impression ?? '',
    incidentalFindings: existing?.incidental_findings ?? false,
    referral: existing?.referral ?? '',
    note: existing?.note ?? '',
  });
  const inputs = measurements.map(({ label, plane, slice, a, b }) => ({ label, plane, slice, a, b }));
  const save = useMutation({
    mutationFn: () => {
      if (existing) {
        const changes: Record<string, unknown> = {};
        const cols: [keyof typeof f, string][] = [
          ['entireVolumeReviewed', 'entire_volume_reviewed'],
          ['findings', 'findings'],
          ['impression', 'impression'],
          ['incidentalFindings', 'incidental_findings'],
          ['referral', 'referral'],
          ['note', 'note'],
        ];
        for (const [k, col] of cols) if ((f[k] || null) !== ((existing[col] as unknown) || null)) changes[col] = f[k] === '' ? null : f[k];
        if (JSON.stringify(inputs) !== JSON.stringify(existing.measurements.map(({ label, plane, slice, a, b }) => ({ label, plane, slice, a, b })))) changes.measurements = inputs;
        return api.post(`/entries/imaging-reads/${existing.id}/edit`, { expectedVersion: existing.version, changes });
      }
      return api.post(`/encounters/${visit.encounter.id}/imaging-reads`, {
        studyId: study.study_id,
        entireVolumeReviewed: cbct ? f.entireVolumeReviewed : false,
        findings: f.findings,
        impression: f.impression,
        incidentalFindings: f.incidentalFindings,
        referral: f.incidentalFindings ? f.referral || undefined : undefined,
        measurements: inputs,
        note: f.note || undefined,
      });
    },
    onSuccess: onDone,
  });
  const bad = measurements.filter((m) => typeof measureMm({ rows: study.rows, columns: study.columns, slices: study.slices, spacing: [Number(study.voxel_x_mm), Number(study.voxel_y_mm), Number(study.voxel_z_mm)] }, m) !== 'number');
  return (
    <form
      className="read-form"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label className="field">
        <span className="lbl">Findings</span>
        <textarea rows={4} value={f.findings} onChange={(e) => setF({ ...f, findings: e.target.value })} required maxLength={5000} placeholder="What you see, region by region, including outside the area of interest" />
      </label>
      <label className="field">
        <span className="lbl">Impression</span>
        <input value={f.impression} onChange={(e) => setF({ ...f, impression: e.target.value })} required maxLength={2000} />
      </label>
      <label className="checks">
        <span>
          <input type="checkbox" checked={f.incidentalFindings} onChange={(e) => setF({ ...f, incidentalFindings: e.target.checked })} /> Incidental findings outside the area of interest
        </span>
      </label>
      {f.incidentalFindings && (
        <label className="field">
          <span className="lbl">Follow-up or referral</span>
          <input value={f.referral} onChange={(e) => setF({ ...f, referral: e.target.value })} required maxLength={500} placeholder="For example: refer to ENT for sinus mucosal thickening" />
        </label>
      )}
      <label className="field">
        <span className="lbl">Note</span>
        <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={1000} />
      </label>
      <p className="small muted">
        {measurements.length === 0 ? 'No measurements. Use Measure in the viewer to add them.' : `${measurements.length} measurement${measurements.length === 1 ? '' : 's'} from the viewer will be saved with the read.`}
      </p>
      {cbct && (
        <label className="checks attest">
          <span>
            <input type="checkbox" checked={f.entireVolumeReviewed} onChange={(e) => setF({ ...f, entireVolumeReviewed: e.target.checked })} /> I reviewed the entire volume, every slice in all three views, not only the
            area the scan was taken for.
          </span>
        </label>
      )}
      {save.error && <Callout>{errorText(save.error)}</Callout>}
      <div className="row">
        <button className="btn primary" disabled={save.isPending || (cbct && !f.entireVolumeReviewed) || bad.length > 0}>
          {existing ? (existing.locked_at ? 'Save amended read' : 'Save read') : 'Record read'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

const readFile = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error(`Couldn’t read ${file.name}`));
    r.readAsDataURL(file);
  });

function UploadForm({ visit, onDone, onCancel }: { visit: Visit; onDone(studyId: string): void; onCancel(): void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [f, setF] = useState({ modality: 'cbct', region: 'localized', teeth: '', note: '', identityConfirmation: '' });
  const [identity, setIdentity] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const data = await Promise.all(files.map(readFile));
      return api.post<{ id: string }>(`/encounters/${visit.encounter.id}/imaging-studies`, {
        modality: f.modality,
        region: f.region,
        teeth: f.teeth.split(/[\s,#]+/).filter(Boolean),
        files: data,
        note: f.note || undefined,
        identityConfirmation: identity ? f.identityConfirmation : undefined,
      });
    },
    onSuccess: (r) => onDone(r.id),
    onError: (e) => {
      if (e instanceof ApiError && (e.details as { reason?: string } | undefined)?.reason === 'identity_check') setIdentity(e.message);
    },
  });
  const size = files.reduce((n, x) => n + x.size, 0);
  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h3>Upload a DICOM series</h3>
      <div className="grid2">
        <label className="field">
          <span className="lbl">Kind of study</span>
          <select value={f.modality} onChange={(e) => setF({ ...f, modality: e.target.value })}>
            {IMAGING_MODALITIES.map((m) => (
              <option key={m} value={m}>
                {imagingLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Region</span>
          <select value={f.region} onChange={(e) => setF({ ...f, region: e.target.value })}>
            {IMAGING_REGIONS.map((m) => (
              <option key={m} value={m}>
                {imagingLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="lbl">Teeth{f.region === 'localized' ? '' : ' (optional)'}</span>
          <input value={f.teeth} onChange={(e) => setF({ ...f, teeth: e.target.value })} placeholder="e.g. 29, 30, 31" required={f.region === 'localized'} />
        </label>
        <label className="field">
          <span className="lbl">DICOM files of one series</span>
          <input type="file" multiple accept=".dcm,application/dicom" onChange={(e) => { setFiles(Array.from(e.target.files ?? [])); setIdentity(null); }} required />
        </label>
      </div>
      {files.length > 0 && (
        <p className="small muted">
          {files.length} file{files.length === 1 ? '' : 's'}, {(size / 1024 / 1024).toFixed(1)} MB
        </p>
      )}
      <label className="field">
        <span className="lbl">Note</span>
        <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} maxLength={1000} />
      </label>
      {identity && (
        <Callout kind="error" title="Check this is the right patient">
          {identity}
          <label className="field" style={{ marginTop: 8 }}>
            <span className="lbl">How do you know these images are this patient’s?</span>
            <textarea rows={2} value={f.identityConfirmation} onChange={(e) => setF({ ...f, identityConfirmation: e.target.value })} minLength={10} maxLength={500} required />
          </label>
        </Callout>
      )}
      {save.error && !identity && <Callout>{errorText(save.error)}</Callout>}
      <div className="row">
        <button className="btn primary" disabled={save.isPending || files.length === 0}>
          {save.isPending ? 'Uploading…' : identity ? 'Upload anyway, with my reason' : 'Upload'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function VoidButton({ route, entry, onChanged }: { route: string; entry: Entry; onChanged(): void }) {
  const act = useMutation({ mutationFn: (reason: string) => api.post(`/entries/${route}/${entry.id}/void`, { reason }), onSuccess: onChanged });
  return (
    <>
      <button
        className="btn small"
        onClick={() => {
          const reason = window.prompt('Why is this entry being voided? (kept with the record)');
          if (reason) act.mutate(reason);
        }}
      >
        Void
      </button>
      {act.error && <span className="err">{errorText(act.error)}</span>}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/** One line per study and read for the visit ledger and the sign-off review. */
export function ImagingLine({ visit }: { visit: Visit }) {
  const studies = live(visit.entries.imaging_study);
  const reads = live(visit.entries.imaging_read);
  if (studies.length + reads.length === 0) return null;
  return (
    <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
      {studies.map((s) => (
        <li key={s.id}>
          <b>{studyTitle(s)}</b>: {s.slices > 1 ? `${s.slices} slices` : 'one image'} at {mmText(s.voxel_x_mm)} mm
          {s.patient_match !== 'matched' && (
            <>
              , <span aria-hidden="true">⚠ </span>
              {imagingLabel(s.patient_match).toLowerCase()}
            </>
          )}
          . Open the Imaging tab to view it.
        </li>
      ))}
      {reads.map((r) => (
        <li key={r.id}>
          <b>Imaging read</b>: {r.impression}
          {r.measurements.length > 0 && ` (${r.measurements.map((m) => `${m.label} ${m.mm.toFixed(1)} mm`).join('; ')})`}
          {r.incidental_findings && (
            <>
              ; <span aria-hidden="true">▲ </span>incidental finding, {r.referral}
            </>
          )}
          {r.entire_volume_reviewed && '; whole volume reviewed'}
        </li>
      ))}
    </ul>
  );
}
