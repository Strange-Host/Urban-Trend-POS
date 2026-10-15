export function SectionCard({ title, description, children }) {
  return (
    <div className="bg-surface border border-line rounded-xl p-4 sm:p-5 mb-6">
      <div className="mb-4">
        <div className="font-medium text-sm">{title}</div>
        {description && <div className="text-text-muted text-xs mt-0.5">{description}</div>}
      </div>
      {children}
    </div>
  );
}

// Wraps children directly inside the <label> — this associates the label
// with its input without needing explicit htmlFor/id, since the browser
// treats a nested control as implicitly labeled by its containing <label>.
export function Field({ label, children, hint }) {
  return (
    <label className="block mb-3">
      <div className="text-xs font-medium text-text-muted mb-1">{label}</div>
      {children}
      {hint && <div className="text-xs text-text-muted mt-1">{hint}</div>}
    </label>
  );
}

export const inputCls = "w-full px-3 py-2 rounded-lg border border-line bg-paper text-sm focus:border-text-muted outline-none";
