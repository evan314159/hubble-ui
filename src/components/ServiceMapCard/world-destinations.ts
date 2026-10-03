import { Flow } from '~/domain/flows';

export interface WorldDestination {
  key: string;
  label: string;
  count: number;
  // True when every flow behind this row got its name from an expired DNS
  // record, so the name may be out of date.
  expired: boolean;
}

export type WorldCardDirection = 'egress' | 'ingress' | 'both';

const MAX_DESTINATIONS = 10;

// NOTE: World cards aggregate every real-world IP a given sender talks to
// NOTE: into one node -- this recovers per-destination detail (DNS name, else
// NOTE: expired DNS name, else IP) straight from the recent flow buffer, ranked
// NOTE: by how many flows hit each one. An expired name only stands in for an
// NOTE: IP, never for a current name. Only the host is shown (no port/protocol) -- that
// NOTE: distinction lives on the connector arrow instead, and this space is
// NOTE: reserved for addresses only.
// NOTE: Ingress traffic (world sending into a namespace) isn't broken down at
// NOTE: all: unlike egress destinations -- the useful "what does this
// NOTE: namespace talk to" detail -- the set of external IPs that happen to
// NOTE: reach in is mostly noise.
// NOTE: localNamespace narrows this to one namespace's flows -- used for a
// NOTE: world-split per-namespace card (see world-split.ts), which only
// NOTE: represents traffic that namespace sent, not the whole graph.
// NOTE: cardIdentity accepts more than one identity so a "Group world cards"
// NOTE: merge (see world-merge.ts) can show flows to any original identity on
// NOTE: its one combined card.
export function topWorldDestinations(
  flows: Flow[],
  cardIdentity: number | number[],
  direction: WorldCardDirection,
  localNamespace?: string | null,
): WorldDestination[] {
  if (direction === 'ingress') return [];

  const identities = new Set(Array.isArray(cardIdentity) ? cardIdentity : [cardIdentity]);
  const byKey = new Map<string, WorldDestination>();

  flows.forEach(flow => {
    if (flow.destinationIdentity == null || !identities.has(flow.destinationIdentity)) return;
    if (localNamespace != null && flow.sourceNamespace !== localNamespace) return;

    const expiredName =
      flow.destinationDns == null ? flow.destinationNamesZombieList[0] : undefined;
    const label = flow.destinationDns ?? expiredName ?? flow.destinationIp;
    if (label == null) return;

    const expired = expiredName != null;
    const existing = byKey.get(label);
    if (existing != null) {
      existing.count += 1;
      existing.expired = existing.expired && expired;
    } else {
      byKey.set(label, { key: label, label, count: 1, expired });
    }
  });

  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

export function formatWorldDestination(d: WorldDestination): string {
  return d.label;
}

export { MAX_DESTINATIONS };
