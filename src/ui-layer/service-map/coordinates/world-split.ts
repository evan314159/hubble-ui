import { ServiceCard } from '~/domain/service-map';
import { Link } from '~/domain/link';
import { Flow } from '~/domain/flows';
import { HubbleLink, HubbleService } from '~/domain/hubble';

export interface WorldSplitResult {
  cardsList: ServiceCard[];
  links: Link[];
  // NOTE: Ids present in cardsList that should NOT be laid out/shown right
  // NOTE: now -- the inactive variant (raw pair vs merged) of a world-family
  // NOTE: merge group. elk-placement.ts excludes these from graphInput the
  // NOTE: same way it already excludes a namespace-filtered-out card, which
  // NOTE: sends it into the existing "unsized"/hidden bucket (Map/index.tsx)
  // NOTE: instead of unmounting it.
  hiddenIds: Set<string>;
}

type Direction = 'egress' | 'ingress';

const zeroTime = { seconds: 0, nanos: 0 };

function foldOne(existing: Link | null, senderId: string, receiverId: string, flow: Flow): Link {
  const hubbleLink: HubbleLink = {
    id: `${senderId}->${receiverId}:${flow.destinationPort}/${flow.protocol}`,
    sourceId: senderId,
    destinationId: receiverId,
    destinationPort: flow.destinationPort!,
    ipProtocol: flow.protocol!,
    verdict: flow.verdict,
    flowAmount: 1,
    latency: { min: zeroTime, max: zeroTime, avg: zeroTime },
    bytesTransfered: 0,
    authType: flow.authType,
    isEncrypted: flow.isEncrypted,
  };

  return existing == null
    ? Link.fromHubbleLink(hubbleLink)
    : existing.updateWithHubbleLink(hubbleLink);
}

// NOTE: Re-keys a folded link onto a different sender/receiver pair (used
// NOTE: when composeForDisplay merges two raw per-identity cards into one) --
// NOTE: preserves the accumulated verdicts/authTypes sets, which a plain
// NOTE: Link.fromHubbleLink(link.hubbleLink) would collapse back down to
// NOTE: whatever single verdict/authType that snapshot happened to carry.
function remapLink(link: Link, senderId: string, receiverId: string): Link {
  const hl = link.hubbleLink;
  const remapped = Link.fromHubbleLink({
    ...hl,
    id: `${senderId}->${receiverId}:${hl.destinationPort}/${hl.ipProtocol}`,
    sourceId: senderId,
    destinationId: receiverId,
  });
  remapped.verdicts = new Set(link.verdicts);
  remapped.authTypes = new Set(link.authTypes);
  remapped.isEncrypted = link.isEncrypted;
  return remapped;
}

// NOTE: Combines two already-remapped links landing on the same final
// NOTE: (sender, receiver, port, protocol) key -- e.g. a namespace's flows to
// NOTE: world-ipv4 and world-ipv6 on the same port, once both raw cards fold
// NOTE: into the same merged "World" card id.
function mergeLinksForDisplay(a: Link, b: Link, id: string): Link {
  const merged = Link.fromHubbleLink({
    ...a.hubbleLink,
    id,
    bytesTransfered: a.hubbleLink.bytesTransfered + b.hubbleLink.bytesTransfered,
    flowAmount: a.hubbleLink.flowAmount + b.hubbleLink.flowAmount,
  });
  merged.verdicts = new Set([...a.verdicts, ...b.verdicts]);
  merged.authTypes = new Set([...a.authTypes, ...b.authTypes]);
  merged.isEncrypted = a.isEncrypted && b.isEncrypted;
  return merged;
}

// NOTE: This card keeps the representative real world card's own labels (so
// NOTE: it stays isWorld/isWorldIPv4/isWorldIPv6 and the same identity, for
// NOTE: ServiceMapCard's isAggregateWorldCard check) but carries its own
// NOTE: `namespace` -- that's what makes ELK group it into that namespace's
// NOTE: island instead of placing it top-level like the real world card.
// NOTE: An "app" label wins over the inherited reserved:world-ipv4/6 label
// NOTE: when the card resolves its caption (see ServiceCard.caption/appName),
// NOTE: so `displayName` always wins, with " (Ingress)" appended for the
// NOTE: ingress direction. `siblingIdentities` (every other real identity
// NOTE: this one also represents, populated only by composeForDisplay's
// NOTE: merge step below) is stashed via ServiceCard.MERGED_WORLD_IDENTITY_LABEL
// NOTE: so topWorldDestinations can include flows to/from any of them.
// NOTE: A merged card's `representative` is one of the raw per-namespace
// NOTE: sibling cards, itself already built by this same function -- its own
// NOTE: `service.labels` already carries an 'app' label, a direction label,
// NOTE: and possibly merged-identity labels from a prior compose. Without
// NOTE: stripping those before spreading, the merged card would end up with
// NOTE: two labels sharing the same key (e.g. two
// NOTE: hubble-ui.io/world-card-direction entries), which is both wrong data
// NOTE: and a React duplicate-key warning wherever labels are rendered as a
// NOTE: list keyed by label.key.
const OWN_LABEL_KEYS = new Set([
  'app',
  ServiceCard.MERGED_WORLD_IDENTITY_LABEL,
  ServiceCard.WORLD_CARD_DIRECTION_LABEL,
]);

function buildNamespaceCard(
  cardId: string,
  namespace: string,
  representative: ServiceCard,
  direction: Direction,
  displayName: string,
  siblingIdentities: number[],
): ServiceCard {
  const name = direction === 'egress' ? displayName : `${displayName} (Ingress)`;
  const inheritedLabels = representative.service.labels.filter(l => !OWN_LABEL_KEYS.has(l.key));

  const service: HubbleService = {
    id: cardId,
    name: representative.service.name,
    namespace,
    labels: [
      { key: 'app', value: name },
      ...inheritedLabels,
      ...siblingIdentities.map(identity => ({
        key: ServiceCard.MERGED_WORLD_IDENTITY_LABEL,
        value: String(identity),
      })),
      { key: ServiceCard.WORLD_CARD_DIRECTION_LABEL, value: direction },
    ],
    dnsNames: [],
    egressPolicyEnforced: false,
    ingressPolicyEnforced: false,
    visibilityPolicyStatus: '',
    creationTimestamp: representative.service.creationTimestamp,
    workloads: [],
    identity: representative.identity,
  };

  return ServiceCard.fromService(service);
}

// NOTE: A world card aggregates every real-world destination talking to every
// NOTE: sender (or vice versa) across the whole graph into one node -- this
// NOTE: replaces it with two cards per namespace instead, one for traffic
// NOTE: that namespace sends to the world (egress) and one for traffic the
// NOTE: world sends into it (ingress), each placed inside that namespace's
// NOTE: own island, so edges into/out of world traffic stay local to the
// NOTE: namespace they touch rather than criss-crossing the whole map into
// NOTE: one distant node.
// NOTE: (An earlier version split by individual destination -- DNS name or
// NOTE: IP -- instead of namespace, but that produced dozens of top-level
// NOTE: cards with edges routed all over the screen; namespace grouping fixes
// NOTE: both problems at once, and still shows the same per-destination
// NOTE: breakdown via WorldDestinations, just scoped to one namespace's flows.)
//
// NOTE: This is stateful (unlike a pure recompute from the current flow
// NOTE: buffer) on purpose: the buffer is capped
// NOTE: (InteractionStore.FLOWS_MAX_COUNT) -- on a busy cluster a namespace's
// NOTE: most recent flow into a world identity ages out of it within a second
// NOTE: or two. Recomputing fresh from the buffer every time would make these
// NOTE: cards flicker in and out of the graph as their evidence rolls out,
// NOTE: causing constant relayout/remount churn. Instead, each flow is folded
// NOTE: in exactly once and a (namespace, world identity, direction) triple is
// NOTE: remembered for the lifetime of this instance (reset alongside the
// NOTE: rest of the placement strategy's state).
//
// NOTE: Folding always keys on the *raw* identity (world-ipv4 and world-ipv6
// NOTE: are never merged at fold time) -- "Group world cards" is purely a
// NOTE: display-time concern, applied in composeForDisplay() over whatever has
// NOTE: already been collected. An earlier version folded straight into a
// NOTE: merged "canonical" card, which meant flipping the toggle (or even just
// NOTE: the merge group completing as world-ipv6 and world-ipv4 are discovered
// NOTE: at different times) could leave namespace cards keyed under a stale
// NOTE: identity, or silently lose whichever raw identity's data hadn't
// NOTE: recurred since -- since collection no longer depends on the toggle at
// NOTE: all, neither failure mode can happen anymore, and toggling is just a
// NOTE: cheap re-composition of already-complete data, not a data loss risk.
interface FoldResult {
  matched: boolean;
  // NOTE: True only when the *set* of cards/edges changed (a new namespace
  // NOTE: card or a new distinct sender/port combination) -- not merely when
  // NOTE: a flow updated an existing link's byte/flow counters. apply() uses
  // NOTE: this (not "was any flow folded") to decide whether its output needs
  // NOTE: to be rebuilt at all, since a busy world card can have flows
  // NOTE: folded into it almost every tick while the actual node/edge shape
  // NOTE: stays unchanged for long stretches.
  structuralChange: boolean;
}

export class WorldNamespaceSplitter {
  private processedFlowIds: Set<string> = new Set();
  private nsCards: Map<string, ServiceCard> = new Map();
  private nsLinks: Map<string, Link> = new Map();
  // NOTE: Reused whenever nothing relevant changed, so that
  // NOTE: ElkServiceMapPlacementStrategy.effectiveGraphData -- and everything
  // NOTE: downstream of it (graphInput, ELK layout, DOM remeasurement) -- see
  // NOTE: the same cardsList/links reference and correctly no-op via MobX's
  // NOTE: own (reference-equality) computed memoization, instead of
  // NOTE: rebuilding and relaying-out on every single flow.
  private lastResult: WorldSplitResult | null = null;
  // NOTE: A cache-hit also requires the raw cardsList/links arguments to be
  // NOTE: unchanged, not just "no world-relevant structural change" -- a
  // NOTE: brand new plain pod-to-pod link never touches foldDirection at all
  // NOTE: (it's not world-identity-related), so without this it would
  // NOTE: silently disappear behind a stale cached result until some
  // NOTE: unrelated world-side change happened to force a rebuild. Both are
  // NOTE: themselves stable computeds upstream, so comparing by reference is
  // NOTE: cheap and doesn't reintroduce per-flow churn.
  private lastCardsList: ServiceCard[] | null = null;
  private lastLinks: Link[] | null = null;
  private lastMergeWorldFamilies: boolean | null = null;

  public reset(): void {
    this.processedFlowIds.clear();
    this.nsCards.clear();
    this.nsLinks.clear();
    this.lastResult = null;
    this.lastCardsList = null;
    this.lastLinks = null;
    this.lastMergeWorldFamilies = null;
  }

  // NOTE: Every raw world identity ever folded stays split out of the
  // NOTE: top-level graph for the life of this instance, regardless of the
  // NOTE: current "Group world cards" setting -- composeForDisplay decides
  // NOTE: separately whether to show it on its own or merged with a sibling.
  private get touchedRawIds(): Set<string> {
    const ids = new Set<string>();

    this.nsCards.forEach((_card, cardId) => {
      const sep = cardId.indexOf('::ns::');
      if (sep > 0) ids.add(cardId.slice(0, sep));
    });

    return ids;
  }

  private buildWorldIdentityIndex(cardsList: ServiceCard[]): Map<number, ServiceCard> {
    const map = new Map<number, ServiceCard>();
    cardsList.forEach(card => {
      if (card.isWorld) map.set(card.identity, card);
    });
    return map;
  }

  public apply(
    cardsList: ServiceCard[],
    links: Link[],
    flows: Flow[],
    mergeWorldFamilies: boolean,
  ): WorldSplitResult {
    const worldCardsByIdentity = this.buildWorldIdentityIndex(cardsList);
    if (worldCardsByIdentity.size === 0) return { cardsList, links, hiddenIds: new Set() };

    let structuralChange = false;
    flows.forEach(flow => {
      if (this.processedFlowIds.has(flow.id)) return;

      const egress = this.foldDirection(flow, worldCardsByIdentity, 'egress');
      const result = egress.matched
        ? egress
        : this.foldDirection(flow, worldCardsByIdentity, 'ingress');

      if (result.matched) {
        this.processedFlowIds.add(flow.id);
        if (result.structuralChange) structuralChange = true;
      }
    });

    // NOTE: Bound processedFlowIds to the buffer's own size instead of
    // NOTE: growing forever -- a flow that has aged out of the buffer can
    // NOTE: never reappear, so there's no need to keep remembering its id.
    this.processedFlowIds = new Set(flows.map(f => f.id));

    if (this.nsCards.size === 0) return { cardsList, links, hiddenIds: new Set() };

    const inputsChanged = cardsList !== this.lastCardsList || links !== this.lastLinks;
    this.lastCardsList = cardsList;
    this.lastLinks = links;

    const toggleChanged = mergeWorldFamilies !== this.lastMergeWorldFamilies;
    this.lastMergeWorldFamilies = mergeWorldFamilies;

    if (!structuralChange && !inputsChanged && !toggleChanged && this.lastResult != null) {
      return this.lastResult;
    }

    const result = this.composeForDisplay(cardsList, links, mergeWorldFamilies);
    this.lastResult = result;

    return result;
  }

  // NOTE: "egress" is the namespace-sends-to-world case (flow.destination is
  // NOTE: world, the card goes in the sender's namespace); "ingress" is the
  // NOTE: world-sends-into-namespace case (flow.source is world, the card
  // NOTE: goes in the receiver's namespace, and is itself the link's sender).
  private foldDirection(
    flow: Flow,
    worldCardsByIdentity: Map<number, ServiceCard>,
    direction: Direction,
  ): FoldResult {
    const notMatched: FoldResult = { matched: false, structuralChange: false };

    const isEgress = direction === 'egress';
    const worldIdentity = isEgress ? flow.destinationIdentity : flow.sourceIdentity;
    if (worldIdentity == null) return notMatched;

    const worldCard = worldCardsByIdentity.get(worldIdentity);
    if (worldCard == null) return notMatched;

    const port = flow.destinationPort;
    const protocol = flow.protocol;
    const localId = isEgress ? flow.sourceServiceId : flow.destinationServiceId;
    if (port == null || protocol == null) return notMatched;

    // NOTE: A null namespace here means the local (non-world) side isn't a
    // NOTE: namespaced k8s object at all -- a Cilium reserved identity like
    // NOTE: reserved:host/remote-node/kube-apiserver talking directly to
    // NOTE: world. There's no real namespace to group this into, and a
    // NOTE: synthetic "unknown" island wasn't useful, so this traffic is
    // NOTE: dropped from the world-split view entirely rather than shown
    // NOTE: under a fake namespace.
    const localNamespace = isEgress ? flow.sourceNamespace : flow.destinationNamespace;
    if (localNamespace == null) return notMatched;

    const cardId = `${worldCard.id}::ns::${localNamespace}::${direction}`;

    let structuralChange = false;

    let card = this.nsCards.get(cardId);
    if (card == null) {
      card = buildNamespaceCard(
        cardId,
        localNamespace,
        worldCard,
        direction,
        worldCard.caption,
        [],
      );
      this.nsCards.set(cardId, card);
      structuralChange = true;
    }

    const senderId = isEgress ? localId : cardId;
    const receiverId = isEgress ? cardId : localId;

    const linkKey = `${senderId}::${receiverId}::${port}/${protocol}`;
    const existingLink = this.nsLinks.get(linkKey) ?? null;
    if (existingLink == null) structuralChange = true;

    this.nsLinks.set(linkKey, foldOne(existingLink, senderId, receiverId, flow));

    return { matched: true, structuralChange };
  }

  // NOTE: Everything above collects one card+link set per raw world identity,
  // NOTE: completely independent of "Group world cards". This step is the
  // NOTE: only place that setting matters -- and it never adds or removes a
  // NOTE: card/link from the output based on the toggle. Both the raw
  // NOTE: sibling cards (e.g. world-ipv4 and world-ipv6 for a namespace's
  // NOTE: egress) AND their merged "World" card are ALWAYS included; the
  // NOTE: toggle only decides which variant goes into `hiddenIds`.
  // NOTE: elk-placement.ts excludes hidden ids from ELK's graph the same way
  // NOTE: it already excludes a namespace-filtered-out card, which sends it
  // NOTE: into the existing "unsized"/hidden bucket (Map/index.tsx) --
  // NOTE: already-mounted, already-measured, just not laid out or shown.
  // NOTE: This means toggling never mounts or unmounts a single card: no
  // NOTE: fresh measurement/layout bootstrap, no passive-effect remount
  // NOTE: churn, regardless of which state the toggle starts or ends in.
  private composeForDisplay(
    cardsList: ServiceCard[],
    links: Link[],
    mergeWorldFamilies: boolean,
  ): WorldSplitResult {
    const touchedRawIds = this.touchedRawIds;
    const remainingCards = cardsList.filter(card => !touchedRawIds.has(card.id));
    const remainingLinks = links.filter(
      link => !touchedRawIds.has(link.destinationId) && !touchedRawIds.has(link.sourceId),
    );

    // NOTE: Grouped by the "::ns::<namespace>::<direction>" suffix shared by
    // NOTE: sibling raw identities' cardIds -- deliberately per-(namespace,
    // NOTE: direction) rather than one global merge decision, so a namespace
    // NOTE: that has only ever talked to world-ipv4 still gets its own
    // NOTE: "World" variant to toggle to/from, uniformly with every other
    // NOTE: group -- whether a group has one contributor or several isn't
    // NOTE: something the toggle's behavior should depend on.
    const groups = new Map<string, ServiceCard[]>();
    const passthroughCards: ServiceCard[] = [];

    this.nsCards.forEach((card, cardId) => {
      if (!(card.isWorldIPv4 || card.isWorldIPv6)) {
        passthroughCards.push(card);
        return;
      }

      const suffix = cardId.slice(cardId.indexOf('::ns::'));
      if (!groups.has(suffix)) groups.set(suffix, []);
      groups.get(suffix)!.push(card);
    });

    const rawGroupCards: ServiceCard[] = [];
    const mergedCards: ServiceCard[] = [];
    const hiddenIds = new Set<string>();
    // NOTE: Raw nsCard id -> the merged card id it also displays as (when
    // NOTE: merged is the active variant), used below to build the merged
    // NOTE: link set alongside (not instead of) the raw one.
    const idRemap = new Map<string, string>();

    groups.forEach((group, suffix) => {
      rawGroupCards.push(...group);

      // NOTE: The merged card's id is derived purely from the shared suffix,
      // NOTE: not from "whichever raw sibling is canonical" -- it's a third,
      // NOTE: permanent card that coexists with both raw siblings for the
      // NOTE: life of this instance, not a stand-in that replaces them.
      const mergedId = `world-merged${suffix}`;
      const sorted = [...group].sort((a, b) => a.identity - b.identity);
      const representative = sorted[0];
      const siblingIdentities = sorted.map(c => c.identity);
      const direction: Direction = suffix.endsWith('::ingress') ? 'ingress' : 'egress';

      mergedCards.push(
        buildNamespaceCard(
          mergedId,
          representative.namespace ?? 'unknown',
          representative,
          direction,
          'World',
          siblingIdentities,
        ),
      );

      sorted.forEach(card => idRemap.set(card.id, mergedId));

      if (mergeWorldFamilies) {
        sorted.forEach(card => hiddenIds.add(card.id));
      } else {
        hiddenIds.add(mergedId);
      }
    });

    const mergedLinks = new Map<string, Link>();
    if (idRemap.size > 0) {
      this.nsLinks.forEach(link => {
        const newSender = idRemap.get(link.sourceId);
        const newReceiver = idRemap.get(link.destinationId);
        if (newSender == null && newReceiver == null) return;

        const finalSender = newSender ?? link.sourceId;
        const finalReceiver = newReceiver ?? link.destinationId;
        const key = `${finalSender}::${finalReceiver}::${link.destinationPort}/${link.ipProtocol}`;
        const remapped = remapLink(link, finalSender, finalReceiver);
        const existing = mergedLinks.get(key);
        mergedLinks.set(
          key,
          existing == null ? remapped : mergeLinksForDisplay(existing, remapped, key),
        );
      });
    }

    return {
      cardsList: [...remainingCards, ...passthroughCards, ...rawGroupCards, ...mergedCards],
      links: [...remainingLinks, ...this.nsLinks.values(), ...mergedLinks.values()],
      hiddenIds,
    };
  }
}
