import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { employeesApi, staffApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { fetchAll } from '../api/fetchAll';

const DOC_TYPES = [
  { value: 'national_id', label: 'National ID' },
  { value: 'cv', label: 'CV' },
  { value: 'contract', label: 'Signed contract' },
];

const emptyHire = { name: '', email: '', phone: '', password: '', role: 'cashier' };

export default function Employees() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyHire);
  const [selectedId, setSelectedId] = useState(null);
  const [docForm, setDocForm] = useState({ doc_type: 'national_id', file_reference: '' });
  const [signedName, setSignedName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: staffList } = useQuery({
    queryKey: ['staff', 'all'],
    queryFn: () => fetchAll(staffApi.list),
  });

  const { data: status } = useQuery({
    queryKey: ['employees', selectedId],
    queryFn: () => employeesApi.onboardingStatus(selectedId).then((r) => r.data.data),
    enabled: !!selectedId,
  });

  // Only accounts actually created through this gated flow are in scope
  // here — staff created via the plain Staff page are active immediately
  // and have nothing to onboard.
  const pending = (staffList || []).filter((s) => s.onboarding_status && s.onboarding_status !== 'active');

  async function run(fn, successMessage) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      if (successMessage) setNotice(successMessage);
      queryClient.invalidateQueries({ queryKey: ['employees'] });
      queryClient.invalidateQueries({ queryKey: ['staff'] });
    } catch (err) {
      setError(getErrorMessage(err, 'That action failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function handleOnboard() {
    await run(async () => {
      const { data } = await employeesApi.onboard(form);
      setForm(emptyHire);
      setSelectedId(data.data.id);
    }, 'New hire created — inactive until documents and signature are complete.');
  }

  return (
    <div className="p-4 md:p-6 max-w-4xl">
      <h1 className="font-display font-700 text-2xl mb-1">Employee onboarding</h1>
      <p className="text-text-muted text-sm mb-5">
        Hires added here can't log in until their documents are uploaded and they've signed the staff
        policy. For a quick internal account with no paperwork gate, use the Staff page instead.
      </p>

      {error && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}
      {notice && <div className="mb-4 px-3.5 py-2.5 rounded-lg bg-success-soft text-success text-sm">{notice}</div>}

      <div className="bg-surface border border-line rounded-xl p-5 mb-6">
        <div className="font-display font-600 mb-3">Add a new hire</div>
        <div className="grid sm:grid-cols-2 gap-3">
          <input placeholder="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="px-3 py-2 rounded-lg border border-line bg-surface text-sm outline-none focus:border-accent" />
          <input placeholder="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="px-3 py-2 rounded-lg border border-line bg-surface text-sm outline-none focus:border-accent" />
          <input placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="px-3 py-2 rounded-lg border border-line bg-surface text-sm outline-none focus:border-accent" />
          <input placeholder="Temporary password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="px-3 py-2 rounded-lg border border-line bg-surface text-sm outline-none focus:border-accent" />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
            className="px-3 py-2 rounded-lg border border-line bg-surface text-sm outline-none focus:border-accent">
            <option value="cashier">Cashier / telesales</option>
            <option value="store">Storekeeper</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
          <button onClick={handleOnboard} disabled={busy}
            className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50">
            Create new hire
          </button>
        </div>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-line font-display font-600 text-sm">
          Awaiting onboarding ({pending.length})
        </div>
        {pending.length === 0 && (
          <div className="p-8 text-center text-text-muted text-sm">
            Nobody is mid-onboarding right now.
          </div>
        )}
        {pending.map((s) => (
          <button
            key={s.id}
            onClick={() => { setSelectedId(s.id); setError(''); setNotice(''); }}
            className={`w-full text-left px-4 py-3 border-b border-line last:border-0 hover:bg-paper ${selectedId === s.id ? 'bg-accent/10' : ''}`}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{s.name}</div>
                <div className="text-xs text-text-muted font-mono">{s.email} · {s.role}</div>
              </div>
              <span className="px-2 py-0.5 rounded-full text-xs bg-accent/20 text-accent-ink">
                {s.onboarding_status === 'pending_documents' ? 'Needs documents' : 'Needs signature'}
              </span>
            </div>
          </button>
        ))}
      </div>

      {status && (
        <div className="bg-surface border border-line rounded-xl p-5">
          <div className="font-display font-600 mb-3">{status.name}</div>

          <div className="mb-4">
            <div className="text-xs font-medium mb-2">Required documents</div>
            <div className="space-y-1.5">
              {DOC_TYPES.map((d) => {
                const uploaded = status.documents?.find((doc) => doc.doc_type === d.value);
                return (
                  <div key={d.value} className="flex items-center justify-between text-sm">
                    <span>{d.label}</span>
                    {uploaded
                      ? <span className="text-success text-xs font-mono">uploaded {new Date(uploaded.uploaded_at).toLocaleDateString()}</span>
                      : <span className="text-text-muted text-xs">missing</span>}
                  </div>
                );
              })}
            </div>
          </div>

          {status.missingDocs?.length > 0 && (
            <div className="border border-line rounded-lg p-3 mb-4">
              <div className="text-xs font-medium mb-2">Upload a document</div>
              <div className="flex flex-col sm:flex-row gap-2">
                <select
                  value={docForm.doc_type}
                  onChange={(e) => setDocForm({ ...docForm, doc_type: e.target.value })}
                  className="px-3 py-2 rounded-lg border border-line bg-surface text-sm outline-none"
                >
                  {DOC_TYPES.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
                <input
                  placeholder="Link to the file (Drive, storage URL…)"
                  value={docForm.file_reference}
                  onChange={(e) => setDocForm({ ...docForm, file_reference: e.target.value })}
                  className="flex-1 px-3 py-2 rounded-lg border border-line bg-surface text-sm font-mono outline-none focus:border-accent"
                />
                <button
                  onClick={() => run(async () => {
                    await employeesApi.uploadDocument(selectedId, docForm);
                    setDocForm({ ...docForm, file_reference: '' });
                  }, 'Document recorded.')}
                  disabled={busy || !docForm.file_reference}
                  className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
                >
                  Record
                </button>
              </div>
              <p className="text-text-muted text-xs mt-2">
                This app doesn't store files itself — upload the document wherever you keep records and
                paste the link here.
              </p>
            </div>
          )}

          {status.onboarding_status === 'pending_signature' && (
            <div className="border border-line rounded-lg p-3">
              <div className="text-xs font-medium mb-1">Policy signature</div>
              <p className="text-text-muted text-xs mb-2">
                Have the employee read the staff policy, then type their full name to sign. This activates
                their account. Signing is recorded against policy version {status.currentPolicyVersion}.
              </p>
              <div className="flex gap-2">
                <input
                  placeholder="Employee's full name"
                  value={signedName}
                  onChange={(e) => setSignedName(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg border border-line bg-surface text-sm outline-none focus:border-accent"
                />
                <button
                  onClick={() => run(async () => {
                    await employeesApi.signAgreement(selectedId, signedName);
                    setSignedName('');
                  }, 'Signed — the account is now active.')}
                  disabled={busy || !signedName.trim()}
                  className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
                >
                  Sign &amp; activate
                </button>
              </div>
            </div>
          )}

          {status.onboarding_status === 'active' && (
            <div className="px-3 py-2 rounded-lg bg-success-soft text-success text-sm">
              Fully onboarded — this account can log in.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
