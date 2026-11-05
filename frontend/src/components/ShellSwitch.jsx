import { lazy } from 'react';
import Layout from './Layout';
import useUiVersion from '../hooks/useUiVersion';

// The new shell is a separate chunk: people on the current layout never download it. (App.jsx's <Suspense> covers the
// moment it loads, with the same page skeleton as any other lazy page.)
const LayoutV2 = lazy(() => import('./v2/LayoutV2'));

// The one place that decides which shell wraps the authenticated pages. Both shells render an <Outlet />,
// so the routes in App.jsx do not change between versions.
export default function ShellSwitch() {
  const { isV2 } = useUiVersion();
  return isV2 ? <LayoutV2 /> : <Layout />;
}
