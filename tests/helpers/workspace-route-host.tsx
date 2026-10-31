import { WorkspaceDisplayProvider } from '../../src/features/sharing/v2-ui/workspace-data';
import { V2WorkspaceRoute } from '../../src/features/sharing/v2-ui/workspace-route';
import type { V2GroupScreenProps } from '../../src/features/sharing/v2-ui/group-screen';
export function WorkspaceRouteHost({ view }: { view: V2GroupScreenProps['view'] }) {
  return <WorkspaceDisplayProvider><V2WorkspaceRoute view={view} /></WorkspaceDisplayProvider>;
}
