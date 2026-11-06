import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { settingsApi, backupsApi } from '../../api/endpoints';
import { getErrorMessage } from '../../api/client';
import { SectionCard, Field, inputCls } from '../../components/SettingsUI';
import { LoadingBlock } from '../../components/Skeleton';

/* -------------------------------- Backups -------------------------------- */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BackupsSection() {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [error, setError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [recipients, setRecipients] = useState(null);
  const [savingRecipients, setSavingRecipients] = useState(false);
  const [recipientsSaved, setRecipientsSaved] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['backups'],
    queryFn: () => backupsApi.list().then((r) => r.data),
  });
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: () => settingsApi.get().then((r) => r.data.data) });
  const backups = data?.data;
  const emailConfigured = data?.emailConfigured;
  const lastEmail = data?.lastEmail;
  const lastLocal = data?.lastLocal;
  const passphraseSet = data?.passphraseSet;

  useEffect(() => { if (settings && recipients === null) setRecipients(settings.backup_email_recipients || ''); }, [settings]);

  async function handleRunNow() {
    setRunning(true);
    setError('');
    try {
      await backupsApi.run();
      queryClient.invalidateQueries({ queryKey: ['backups'] });
    } catch (err) {
      setError(getErrorMessage(err, 'Backup failed.'));
    } finally {
      setRunning(false);
    }
  }

  async function handleEmailNow() {
    setEmailing(true);
    setEmailError('');
    try {
      await backupsApi.emailNow();
      queryClient.invalidateQueries({ queryKey: ['backups'] });
    } catch (err) {
      setEmailError(getErrorMessage(err, 'Could not send backup email.'));
    } finally {
      setEmailing(false);
    }
  }

  async function handleSaveRecipients() {
    setSavingRecipients(true);
    setRecipientsSaved(false);
    try {
      await settingsApi.update({ backup_email_recipients: recipients });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['backups'] }); // emailConfigured depends on this
      setRecipientsSaved(true);
      setTimeout(() => setRecipientsSaved(false), 2500);
    } finally {
      setSavingRecipients(false);
    }
  }

  return (
    <SectionCard
      title="Backups"
      description="The database is backed up automatically every 6 hours (last 7 days kept, each one checked after it is made), and — when email is configured — an encrypted copy is also emailed off-machine every 24 hours. If the server restarts, an overdue backup runs right away."
    >
      {error && <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{error}</div>}

      <button
        onClick={handleRunNow}
        disabled={running}
        className="px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50 mb-4 mr-2"
      >
        {running ? 'Backing up…' : 'Run backup now'}
      </button>

      {lastLocal && (
        <p className="text-sm mb-3 text-text-muted">
          Last backup: {lastLocal.status === 'ok' ? (
            <span className="text-success">{lastLocal.file} at {new Date(lastLocal.at).toLocaleString()}</span>
          ) : (
            <span className="text-danger">failed ({lastLocal.error}) at {new Date(lastLocal.at).toLocaleString()}</span>
          )}
        </p>
      )}

      {isLoading && <LoadingBlock />}
      {backups?.length === 0 && !isLoading && (
        <div className="text-text-muted text-sm mb-4">
          No backups yet — the first one runs a minute or so after the server starts, or click "Run backup now" above.
        </div>
      )}
      {backups?.length > 0 && (
        <div className="text-sm divide-y divide-line mb-5">
          {backups.slice(0, 8).map((b) => (
            <div key={b.file} className="flex items-center justify-between py-2">
              <span className="font-mono text-xs text-text-muted">{b.file}</span>
              <span className="text-xs text-text-muted">{formatBytes(b.sizeBytes)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-line pt-4">
        <h3 className="text-sm font-medium mb-1">Off-site copy (email)</h3>

        <Field label="Recipient emails" hint="Comma-separated — e.g. owner@urbantrends.com, backups@urbantrends.com. Saved here, no server restart needed.">
          <textarea
            rows={2}
            className={inputCls}
            value={recipients ?? ''}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="owner@urbantrends.com, backups@urbantrends.com"
          />
        </Field>
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={handleSaveRecipients}
            disabled={savingRecipients || recipients === null}
            className="px-4 py-2 rounded-lg bg-ink text-white text-sm font-medium hover:bg-ink-soft disabled:opacity-50"
          >
            {savingRecipients ? 'Saving…' : 'Save recipients'}
          </button>
          {recipientsSaved && <span className="text-success text-sm">Saved.</span>}
        </div>

        {!emailConfigured ? (
          <p className="text-text-muted text-sm">
            Add at least one recipient above, and finish <b>Settings → Email (outgoing mail)</b> (SMTP). It takes
            effect immediately; no restart or server file editing is needed.
          </p>
        ) : (
          <>
            {!passphraseSet && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">
                {data?.passphraseProblem || 'BACKUP_PASSPHRASE is not set.'} Until then no copy is sent off-machine. On Railway add it under <b>Variables</b>, and keep the same phrase in your password manager: it is the only way to open these backups.
              </div>
            )}
            {emailError && <div className="mb-2 px-3 py-2 rounded-lg bg-danger-soft text-danger text-sm">{emailError}</div>}
            {lastEmail ? (
              <p className="text-text-muted text-sm mb-3">
                Last sent: {lastEmail.status === 'sent' ? (
                  <span className="text-success">{lastEmail.file} at {new Date(lastEmail.sentAt).toLocaleString()}</span>
                ) : (
                  <span className="text-danger">failed ({lastEmail.error}) at {new Date(lastEmail.sentAt).toLocaleString()}</span>
                )}
              </p>
            ) : (
              <p className="text-text-muted text-sm mb-3">No email backup sent yet — the first one goes out within about ten minutes once email and the passphrase are set up.</p>
            )}
            <button
              onClick={handleEmailNow}
              disabled={emailing || !passphraseSet}
              className="px-4 py-2 rounded-lg border border-line text-sm font-medium hover:border-text-muted disabled:opacity-50"
            >
              {emailing ? 'Sending…' : 'Send backup email now'}
            </button>
          </>
        )}
      </div>
    </SectionCard>
  );
}
