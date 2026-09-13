import { XY } from '~/domain/geometry';
import { PlacementStrategy } from '~/ui/layout/abstract';
import { ServiceCard } from '~/domain/service-map';
import { LinkConnections } from '~/domain/interactions/connections';

// NOTE: Adds the ELK-computed edge route that ServiceMapArrowStrategy draws,
// NOTE: plus the cards/connections actually laid out -- these can differ from
// NOTE: the raw store data when "Group world destinations" is off (see
// NOTE: world-split.ts), so ServiceMapApp and ServiceMapArrowStrategy read
// NOTE: them from here rather than straight off the store.
export interface ServiceMapPlacement extends PlacementStrategy {
  getEdgeRoute(senderId: string, receiverId: string): XY[] | null;
  cardsList: ServiceCard[];
  connections: LinkConnections;
}
