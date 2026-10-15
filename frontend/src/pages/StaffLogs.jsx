import { useState, Fragment } from 'react';
import StatCard from '../components/StatCard';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { staffLogsApi } from '../api/endpoints';
import Pager, { usePager } from '../components/Pager';

const ENTITY_TYPES = ['lead', 'requisition', 'expense', 'payment', 'staff'];
const ACTIONS = ['create', 'update', 'delete'];

export default function StaffLogs() {
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const { data: stats } = useQuery({
    queryKey: ['staff-logs', 'stats'],
    queryFn: () => staffLogsApi.stats().then((r) => r.data.data),
  });

  const pager = usePager(50);
  const { data, isLoading } = useQuery({
    queryKey: ['staff-logs', { entityType, action, page: pager.page, size: pager.pageSize }],
    queryFn: () => staffLogsApi.list({ ...pager.params, entity_type: entityType || undefined, action: action || undefined }).then((r) => r.data),
    placeholderData: keepPreviousData,
  });
  const logs = data?.data || [];

  return (
    <div className="p-4 md:p-8 max-w-5xl">
      <h1 className="font-display font-700 text-2xl mb-1">Staff logs</h1>
      <p className="text-text-muted text-sm mb-6">Every create, update, and delete across CRM, Requisitions, Expenses, Payments, and Staff — write-only audit trail.</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <StatCard label="Total actions" value={stats?.total_actions ?? '—'} />
        <StatCard label="Creates" value={stats?.creates ?? '—'} />
        <StatCard label="Updates" value={stats?.updates ?? '—'} />
        <StatCard label="Deletes" value={stats?.deletes ?? '—'} />
        <StatCard label="Active staff" value={stats?.active_staff ?? '—'} />
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        <select value={entityType} onChange={(e) => { setEntityType(e.target.value); pager.reset(); }}
          className="px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm">
          <option value="">All entities</option>
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select value={action} onChange={(e) => { setAction(e.target.value); pager.reset(); }}
          className="px-3 py-2 rounded-lg border border-line outline-none focus:border-accent text-sm">
          <option value="">All actions</option>
          {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      <div className="bg-surface border border-line rounded-xl overflow-hidden scroll-x">
        <table className="stack-sm w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <th className="px-4 py-3 font-medium">When</th>
              <th className="px-4 py-3 font-medium">Staff</th>
              <th className="px-4 py-3 font-medium">Action</th>
              <th className="px-4 py-3 font-medium">Entity</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
            {!isLoading && logs.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-text-muted">No logged actions yet.</td></tr>
            )}
            {logs.map((log) => (
              <Fragment key={log.id}>
                <tr className="border-b border-line last:border-0">
                  <td className="px-4 py-3 text-text-muted whitespace-nowrap font-mono text-xs">{log.created_at}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{log.staff_name || '—'}</td>
                  <td className="px-4 py-3 capitalize">{log.action}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{log.entity_type} #{log.entity_id}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                      className="text-xs text-text-muted hover:text-text"
                    >
                      {expandedId === log.id ? 'Hide' : 'Details'}
                    </button>
                  </td>
                </tr>
                {expandedId === log.id && (
                  <tr className="border-b border-line last:border-0 bg-paper">
                    <td colSpan={5} className="px-4 py-3">
                      <pre className="text-xs font-mono whitespace-pre-wrap break-words text-text-muted">
                        {JSON.stringify(log.changes, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <Pager pager={pager} data={data} noun="log entries" />
    </div>
  );
}
