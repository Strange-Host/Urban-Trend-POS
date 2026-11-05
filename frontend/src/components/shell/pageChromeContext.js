import { createContext, useContext } from 'react';

// Two small contexts that let a page's header cooperate with the shell.
//
// ShellChrome: provided by the redesigned shell (LayoutV2) only. Carries the status line and workspace tabs so a page's
//   PageHeader can place them under its title, and `claim()` so the shell stops drawing its own copy above the page.
//   Pages without a PageHeader (the till, the dashboard for now) never claim, so the shell keeps showing them.
// PageSection: set by <PageSection> (PageSection.jsx) around pages embedded inside another page (Finance's Payments,
//   Catalog's Products...). Their PageHeader is a section header: no page title (the parent's tab already names it),
//   no second copy of the chrome.
export const ShellChromeContext = createContext(null);
export const PageSectionContext = createContext(false);

export const useShellChrome = () => useContext(ShellChromeContext);
export const useInPageSection = () => useContext(PageSectionContext);
