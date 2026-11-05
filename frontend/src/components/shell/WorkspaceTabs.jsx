import { Link } from 'react-router-dom';
import { coversPath } from './railModel';

// The pages inside the current workspace, as links to their own routes. Shown only when the workspace has more than
// one page the person can open. Phase 1 ships this plain so every page stays reachable; Phase 2 restyles it as the
// underline tabs and moves it into the page header.
export default function WorkspaceTabs({ pages, path }) {
  if (!pages || pages.length < 2) return null;
  return (
    <nav aria-label="Pages in this workspace" className="overflow-x-auto px-4 lg:px-6">
      <ul className="flex min-w-max gap-5 border-b border-line">
        {pages.map((p) => {
          const active = coversPath(path, p.to);
          return (
            <li key={p.to}>
              <Link
                to={p.to}
                aria-current={active ? 'page' : undefined}
                className={`-mb-px inline-flex min-h-11 items-center border-b-2 text-sm transition-colors ${
                  active ? 'border-accent font-medium text-text' : 'border-transparent text-text-muted hover:text-text'
                }`}
              >
                {p.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
