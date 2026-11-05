// Check-only JSDoc type check (R5). Nothing here is part of the production build.
//
// tsc follows imports, so it also reports errors in files that the typed folders import but that are not typed yet
// (components/, context/, ...). Those are not ours to fix in this stage, so only errors inside SCOPE fail the check.
// To type another folder: fix its errors, then add it to SCOPE and to "include" in jsconfig.json.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = ['src/api/', 'src/hooks/', 'src/utils/uiVersion.js', 'src/types.d.ts'];

const bin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const run = spawnSync(process.execPath, [bin, '-p', 'jsconfig.json', '--pretty', 'false'], { cwd: root, encoding: 'utf8' });
const out = `${run.stdout || ''}${run.stderr || ''}`;
if (run.error) { console.error(run.error); process.exit(2); }

const lines = out.split('\n').filter((l) => l.trim());
const errors = lines.filter((l) => /error TS\d+/.test(l));
const mine = errors.filter((l) => SCOPE.some((s) => l.replaceAll('\\', '/').startsWith(s)));

if (errors.length === 0 && run.status !== 0) { console.error(out); process.exit(2); } // tsc itself failed, e.g. a bad config
if (mine.length) {
  console.error(mine.join('\n'));
  console.error(`\n${mine.length} type error(s) in typed folders (${SCOPE.join(', ')}).`);
  process.exit(1);
}
console.log(`Type check passed for ${SCOPE.join(', ')}. (${errors.length} error(s) in files outside that scope are not checked yet.)`);
