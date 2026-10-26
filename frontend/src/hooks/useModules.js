import { useQuery } from '@tanstack/react-query';
import { modulesApi } from '../api/endpoints';
import { useAuth } from '../context/AuthContext';
import { USE_NEW_SERVER } from '../api/newServer';

// Which optional parts of the system are switched on (Settings > Business > Optional modules):
//   hr       HR & back office - Attendance, Payroll, Onboarding, Requisitions
//   control  control extras   - permission overrides, two-factor set-up, order disputes, risk badges
// On the legacy server both are off until an admin turns them on, and `loaded` is false until the answer arrives, so a page that
// depends on a module can wait instead of flashing the wrong thing.
// The new server has no switches: everything is always on, and there is nothing to ask.
const ALWAYS_ON = { hr: true, control: true, loaded: true };

export default function useModules() {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ['modules'],
    queryFn: () => modulesApi.get().then((r) => r.data.data),
    enabled: !!user && !USE_NEW_SERVER,
    staleTime: 60_000,
  });
  if (USE_NEW_SERVER) return ALWAYS_ON;
  return { hr: !!q.data?.hr, control: !!q.data?.control, loaded: q.isSuccess };
}
