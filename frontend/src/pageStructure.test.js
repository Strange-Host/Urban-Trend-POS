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

// R6: page files stay small enough to review. A page over MAX_PAGE_LINES must be listed with the size it may not grow
// past and the reason. Splitting a page below the limit means removing it from this list (the last test insists).
const MAX_PAGE_LINES = 400;
const OVERSIZE_PAGES = {
  // Empty since R6 step 2. Add a page here only with its ceiling and a reason; remove it when it is split.
};
const lineCount = (f) => f.text.split('\n').length - (f.text.endsWith('\n') ? 1 : 0);
const pageFiles = files.filter((f) => f.path.startsWith('pages/'));

// Files allowed to write their own <h1>.
const OWN_H1 = {
  'components/shell/PageHeader.jsx': 'the one page header',
  'components/SessionGuard.jsx': 'the lock screen: not a page inside the shell',
  'pages/Login.jsx': 'no shell around it',
  'pages/ChangePassword.jsx': 'no shell around it',
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

  it('TabBar only draws filter chips: no caller still asks it for a page variant', () => {
    // TabBar lost its page variant at cutover. A page that wants tabs uses Tabs (or PageHeader's `tabs`).
    expect(offenders((f) => (f.text.match(/<TabBar[\s\S]*?\/>/g) || []).some((use) => /\bvariant=/.test(use)))).toEqual([]);
  });

  it('the redesign flag and the old layout stay gone (redesign Phase 7)', () => {
    // The flag and the three sidebar modes were removed at cutover. Only legacyStorage.js may still name their saved keys,
    // to clear them from browsers that used them.
    const retired = /ut_ui\b|useUiVersion|getUiVersion|setUiVersion|\bisV2\b|ShellSwitch|LayoutV2|v2Only|data-ui|ut_sidebar_mode|ut_nav_collapsed|ut_sidebar_hidden/;
    expect(offenders((f) => retired.test(f.text) && f.path !== 'utils/legacyStorage.js')).toEqual([]);
  });

  it('the exceptions are still needed (remove them from the lists when they stop being true)', () => {
    for (const path of Object.keys(OWN_H1)) expect(files.find((f) => f.path === path)?.text.includes('<h1'), path).toBe(true);
    for (const path of Object.keys(OWN_TABLIST)) expect(files.find((f) => f.path === path)?.text.includes('role="tablist"'), path).toBe(true);
  });

  it('no page file is over the line limit unless it is listed', () => {
    expect(pageFiles.filter((f) => lineCount(f) > MAX_PAGE_LINES && !(f.path in OVERSIZE_PAGES)).map((f) => f.path).sort()).toEqual([]);
  });

  it('a listed oversize page may not grow', () => {
    const grown = Object.entries(OVERSIZE_PAGES)
      .filter(([path, [ceiling]]) => lineCount(files.find((f) => f.path === path)) > ceiling)
      .map(([path]) => path);
    expect(grown).toEqual([]);
  });

  it('a page that is now within the limit is removed from the oversize list', () => {
    for (const path of Object.keys(OVERSIZE_PAGES)) {
      expect(lineCount(files.find((f) => f.path === path)), path).toBeGreaterThan(MAX_PAGE_LINES);
    }
  });
});
