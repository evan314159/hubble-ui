import { Flow } from '~/domain/flows';

export interface WorldDestination {
  key: string;
  label: string;
  count: number;
}

export type WorldCardDirection = 'egress' | 'ingress' | 'both';

const MAX_DESTINATIONS = 10;

// NOTE: World cards aggregate every real-world IP a given sender talks to
// NOTE: into one node -- this recovers per-destination detail (DNS name, else
// NOTE: IP) straight from the recent flow buffer, ranked by how many flows
// NOTE: hit each one. Only the host is shown (no port/protocol) -- that
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

    const label = flow.destinationDns ?? flow.destinationIp;
    if (label == null) return;

    const existing = byKey.get(label);
    if (existing != null) {
      existing.count += 1;
    } else {
      byKey.set(label, { key: label, label, count: 1 });
    }
  });

  return [...byKey.values()].sort((a, b) => b.count - a.count);
}

export function formatWorldDestination(d: WorldDestination): string {
  return d.label;
}

export { MAX_DESTINATIONS };
