import { useSyncExternalStore } from 'react';
import { DEFAULT_UI_VERSION, getUiVersion, setUiVersion, subscribeUiVersion } from '../utils/uiVersion';

/** Which UI this browser is on: { version: 'v1' | 'v2', isV2, setVersion }. Re-renders when the flag changes. */
export default function useUiVersion() {
  const version = useSyncExternalStore(subscribeUiVersion, getUiVersion, () => DEFAULT_UI_VERSION);
  return { version, isV2: version === 'v2', setVersion: setUiVersion };
}
