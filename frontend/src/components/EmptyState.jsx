import { Inbox } from 'lucide-react';

// The one "nothing here" look: a small icon, what is empty, and (optionally) what to do about it.
// Use `title` for the headline and children for the explanation; an `action` is usually a button.
export default function EmptyState({ icon: Icon = Inbox, title, children, action, className = '' }) {
  return (
    <div className={`flex flex-col items-center text-center gap-2 py-6 ${className}`}>
      <span className="w-10 h-10 rounded-full bg-paper border border-line grid place-items-center text-text-muted" aria-hidden="true">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      {title && <p className="font-medium text-sm">{title}</p>}
      {children && <p className="text-sm text-text-muted max-w-sm">{children}</p>}
      {action}
    </div>
  );
}

/** The same thing as a full-width table row. */
export function EmptyRow({ colSpan, children, ...rest }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-6">
        <EmptyState {...rest}>{children}</EmptyState>
      </td>
    </tr>
  );
}
