import { Monitor, Moon, Sun } from 'lucide-react';
import useTheme from '../hooks/useTheme';

const OPTIONS = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'Match device', icon: Monitor },
  { value: 'dark', label: 'Dark', icon: Moon },
];

// Three-way theme picker. Styled for the dark account menu in the rail, where it lives.
export default function ThemeSwitch() {
  const { preference, setPreference } = useTheme();
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2" role="group" aria-label="Theme">
      <span className="text-sm">Theme</span>
      <div className="inline-flex gap-0.5 p-0.5 rounded-lg bg-white/10">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setPreference(value)}
            aria-pressed={preference === value}
            aria-label={label}
            title={label}
            className={`p-1.5 rounded-md transition-colors ${preference === value ? 'bg-accent text-accent-ink' : 'text-white/60 hover:text-white'}`}
          >
            <Icon size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}
