import { PageSectionContext } from './pageChromeContext';

// Wrap pages that are embedded inside another page, so their PageHeader draws a section header instead of a page title.
export default function PageSection({ children }) {
  return <PageSectionContext.Provider value={true}>{children}</PageSectionContext.Provider>;
}
