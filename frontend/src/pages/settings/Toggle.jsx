

export default function Toggle({ checked, onChange, label, hint }) {
  return (
    <label className="flex items-start gap-3 mb-3 cursor-pointer">
      <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-text-muted mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}
