import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '../../api/endpoints';

// The settings object as key/value strings, for the sections that edit a few of them.
export default function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => settingsApi.get().then((r) => r.data.data) });
}
