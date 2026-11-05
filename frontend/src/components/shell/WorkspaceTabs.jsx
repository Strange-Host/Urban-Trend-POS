import Tabs from './Tabs';
import { coversPath } from './railModel';

// The pages inside the current workspace, as links to their own routes. Shown only when the workspace has more than
// one page the person can open. A page's PageHeader draws it under the title; pages without a header get it from the shell.
// `inline` drops the outer padding for the header case.
export default function WorkspaceTabs({ pages, path, inline = false }) {
  if (!pages || pages.length < 2) return null;
  const items = pages.map((p) => ({ key: p.to, label: p.label, to: p.to }));
  const active = pages.find((p) => coversPath(path, p.to))?.to;
  return <Tabs items={items} active={active} label="Pages in this workspace" className={inline ? '' : 'px-4 lg:px-6'} />;
}
