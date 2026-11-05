import Layout from './Layout';
import LayoutV2 from './v2/LayoutV2';
import useUiVersion from '../hooks/useUiVersion';

// The one place that decides which shell wraps the authenticated pages. Both shells render an <Outlet />,
// so the routes in App.jsx do not change between versions.
export default function ShellSwitch() {
  const { isV2 } = useUiVersion();
  return isV2 ? <LayoutV2 /> : <Layout />;
}
