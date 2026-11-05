// Enforcement, not convention: the redesign's page pattern (one header, one tab style) cannot drift back.
// A page that needs an exception must be added to the lists below with a reason, so it is a decision someone can see.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// vitest runs from the frontend folder (import.meta.url is not a file path under jsdom).
const SRC = join(process.cwd(), 'src');

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(jsx|js)$/.test(name) && !/\.test\.(jsx|js)$/.test(name) ? [full] : [];
  });
}
const files = sourceFiles(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, 'utf8') }));
const offenders = (pred) => files.filter(pred).map((f) => f.path).sort();

// Files allowed to write their own <h1>.
const OWN_H1 = {
  'components/shell/PageHeader.jsx': 'the one page header',
  'components/SessionGuard.jsx': 'the lock screen: not a page inside the shell',
  'pages/Login.jsx': 'no shell around it',
  'pages/ChangePassword.jsx': 'no shell around it',
  'pages/Dashboard.jsx': 'greeting header until redesign Phase 4 turns it into Today',
};

// Files allowed to draw their own tab strip (role="tablist").
const OWN_TABLIST = {
  'components/shell/Tabs.jsx': 'the one page tab strip',
  'components/TabBar.jsx': 'filter chips',
  'pages/Dashboard.jsx': 'the date-range switch is a segmented control, not page tabs',
};

describe('page structure', () => {
  it('no page writes its own title row: they use PageHeader', () => {
    expect(offenders((f) => f.text.includes('<h1') && !(f.path in OWN_H1))).toEqual([]);
  });

  it('no page draws its own tab strip: they use Tabs (page tabs) or TabBar filter chips', () => {
    expect(offenders((f) => f.text.includes('role="tablist"') && !(f.path in OWN_TABLIST))).toEqual([]);
  });

  it('TabBar is only used for filters', () => {
    const bad = files.filter((f) => !f.path.startsWith('components/shell/') && f.path !== 'components/TabBar.jsx')
      .filter((f) => (f.text.match(/<TabBar[\s\S]*?\/>/g) || []).some((use) => !use.includes('variant="filter"')))
      .map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it('the exceptions are still needed (remove them from the lists when they stop being true)', () => {
    for (const path of Object.keys(OWN_H1)) expect(files.find((f) => f.path === path)?.text.includes('<h1'), path).toBe(true);
    for (const path of Object.keys(OWN_TABLIST)) expect(files.find((f) => f.path === path)?.text.includes('role="tablist"'), path).toBe(true);
  });
});
