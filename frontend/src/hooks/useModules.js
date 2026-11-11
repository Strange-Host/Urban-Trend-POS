import { useQuery } from '@tanstack/react-query';
import { modulesApi } from '../api/endpoints';
import { useAuth } from '../context/AuthContext';

// Which optional parts of the system are switched on (Settings > Business > Optional modules):
//   control  control extras   - permission overrides, two-factor set-up, order disputes, risk badges
//   branches multi-branch mode - adding branches, stock transfers, other-branch pickers, branch comparison
// control is off until an admin turns it on; branches starts on only when the shop already has more than one branch. `loaded` is false until the answer arrives, so
// a page that depends on a module can wait instead of flashing the wrong thing.
export default function useModules() {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ['modules'],
    queryFn: () => modulesApi.get().then((r) => r.data.data),
    enabled: !!user,
    staleTime: 60_000,
  });
  return { control: !!q.data?.control, branches: !!q.data?.branches, loaded: q.isSuccess };
}
