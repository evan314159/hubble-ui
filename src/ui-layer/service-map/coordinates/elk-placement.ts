import { actionBound, compareStructural, computed, observable, reaction, runInAction } from 'mobx';

import * as protocolHelpers from '~/domain/helpers/protocol';
import { Link } from '~/domain/link';
import { XY, XYWH } from '~/domain/geometry';
import { ServiceCard } from '~/domain/service-map';
import { LinkConnections } from '~/domain/interactions/connections';

import { ControlStore } from '~/store/stores/controls';
import { InteractionStore } from '~/store/stores/interaction';
import { ServiceStore } from '~/store/stores/service';
import { NamespaceStore } from '~/store/stores/namespace';

import { StoreFrame } from '~/store/frame';
import { PlacementStrategy } from '~/ui/layout/abstract';

import { ServiceMapPlacement } from './placement';
import { WorldNamespaceSplitter, WorldSplitResult } from './world-split';
import {
  ElkNodeInput,
  ElkEdgeInput,
  buildElkGraph,
  flattenElkLayout,
  edgeRouteKey,
  createElk,
} from './elk-graph';

interface GraphInput {
  nodes: ElkNodeInput[];
  edges: ElkEdgeInput[];
}

const MAX_LABEL_PORTS = 5;

// NOTE: Collapses one sender->receiver connection's individual access points
// NOTE: down to a short label, one port per line (e.g. "8080/tcp\n51820/udp")
// NOTE: -- see the "one line + label" decision in place of routing a separate
// NOTE: line into each port, and formatPortsLabelLines for why this is
// NOTE: stacked instead of comma-joined.
function formatPortsLabel(links: Iterable<Link>): string {
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const link of links) {
    const key = `${link.destinationPort}/${link.ipProtocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(protocolHelpers.formatPortProtocol(link.destinationPort, link.ipProtocol));
  }

  if (parts.length > MAX_LABEL_PORTS) {
    return [...parts.slice(0, MAX_LABEL_PORTS), `+${parts.length - MAX_LABEL_PORTS}`].join('\n');
  }

  return parts.join('\n');
}

// NOTE: Places cards using elkjs's layered algorithm, grouping cards into one
// NOTE: compound ("island") node per namespace.
// NOTE:
// NOTE: elk.layout() is async (it returns a Promise even without a Web
// NOTE: Worker), which doesn't fit the synchronous `@computed` pattern the
// NOTE: rest of this codebase uses for placement. Instead, a reaction watches
// NOTE: the graph's inputs (card dimensions + connections + namespace
// NOTE: filter) and kicks off a layout run, writing positions back once it
// NOTE: resolves. A generation counter guards against a stale run clobbering
// NOTE: a newer one.
export class ElkServiceMapPlacementStrategy
  extends PlacementStrategy
  implements ServiceMapPlacement
{
  @observable
  private accessor controls: ControlStore;

  @observable
  private accessor interactions: InteractionStore;

  @observable
  private accessor services: ServiceStore;

  @observable
  private accessor namespaces: NamespaceStore;

  @observable
  private accessor _namespaceBBoxes: Map<string, XYWH>;

  @observable
  private accessor _edgeRoutes: Map<string, XY[]>;

  private readonly elk = createElk();
  private readonly worldSplitter = new WorldNamespaceSplitter();
  private generation = 0;
  // NOTE: elk.layout() is async, but graphInput can (and, with a fast flow
  // NOTE: stream, does) change again well before a run started for the
  // NOTE: previous input resolves -- without this, each change would fire
  // NOTE: off its own overlapping elk.layout() call with nothing to bound how
  // NOTE: many are in flight at once, and a fast enough stream piles them up
  // NOTE: faster than they can resolve until the tab runs out of memory. Only
  // NOTE: one run is ever in flight; a change that arrives while busy is
  // NOTE: coalesced into `pendingInput` and picked up as the next (and only
  // NOTE: the next) run once the current one finishes.
  private isLayingOut = false;
  private pendingInput: GraphInput | null = null;
  constructor(frame: StoreFrame) {
    super();
    this.controls = frame.controls;
    this.interactions = frame.interactions;
    this.services = frame.services;
    this.namespaces = frame.namespaces;
    this._namespaceBBoxes = new Map();
    this._edgeRoutes = new Map();

    reaction(
      () => this.graphInput,
      input => void this.runLayout(input),
      { fireImmediately: true, equals: compareStructural },
    );
  }

  @actionBound
  public reset() {
    runInAction(() => {
      super.reset();
      this._namespaceBBoxes.clear();
      this._edgeRoutes.clear();
      this.worldSplitter.reset();
      this.generation++;
    });
  }

  @computed
  public get namespaceBBoxes(): Map<string, XYWH> {
    return new Map(this._namespaceBBoxes);
  }

  // NOTE: The orthogonal route elk.layout() picked for this edge's trunk
  // NOTE: (sender card edge -> receiver's connector area), if one was
  // NOTE: computed in the most recent layout run.
  @computed
  public get edgeRoutes(): Map<string, XY[]> {
    return new Map(this._edgeRoutes);
  }

  public getEdgeRoute(senderId: string, receiverId: string): XY[] | null {
    return this._edgeRoutes.get(edgeRouteKey(senderId, receiverId)) ?? null;
  }

  @computed
  public get bbox(): XYWH {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    this.cardsXYs.forEach((xy: XY, cardId: string) => {
      const wh = this.cardsWHs.get(cardId);
      if (wh == null) return;

      minX = Math.min(minX, xy.x);
      minY = Math.min(minY, xy.y);
      maxX = Math.max(maxX, xy.x + wh.w);
      maxY = Math.max(maxY, xy.y + wh.h);
    });

    if (!Number.isFinite(minX)) return XYWH.empty();

    return new XYWH(minX, minY, maxX - minX, maxY - minY);
  }

  // NOTE: Cards whose namespace matches the currently selected one (or, in
  // NOTE: "All namespaces" mode, all cards) always go in; a card from a
  // NOTE: different namespace is only included when cross-namespace activity
  // NOTE: is turned on AND it's actually connected to a home-namespace card
  // NOTE: -- same inclusion rule as PlacementKind.AnotherNamespace today,
  // NOTE: just grouped by its real namespace instead of one flat bucket.
  @computed
  private get graphInput(): GraphInput {
    const currentNs = this.namespaces.current?.namespace;
    const isAllNamespaces = currentNs === '';
    const showCross = this.controls.showCrossNamespaceActivity;

    const included = new Set<string>();

    const hidden = this.hiddenCardIds;

    this.cardsList.forEach(card => {
      if (hidden.has(card.id)) return;

      const isSpecial = this.isSpecialCard(card);
      if (isSpecial || isAllNamespaces || currentNs == null || card.namespace === currentNs) {
        included.add(card.id);
        return;
      }

      if (!showCross) return;
      if (this.isConnectedToNamespace(card.id, currentNs)) included.add(card.id);
    });

    const nodes: ElkNodeInput[] = [];
    this.cardsList.forEach(card => {
      if (!included.has(card.id)) return;

      const wh = this.cardsWHs.get(card.id);
      if (wh == null) return; // not yet DOM-measured; wait for the next mutation

      const namespace = this.isSpecialCard(card) ? null : card.namespace || 'unknown';

      nodes.push({ id: card.id, w: wh.w, h: wh.h, namespace });
    });
    nodes.sort((a, b) => a.id.localeCompare(b.id));

    const measured = new Set(nodes.map(n => n.id));
    const edges: ElkEdgeInput[] = [];
    this.connections.outgoings.forEach((receivers, senderId) => {
      if (!measured.has(senderId)) return;

      receivers.forEach((links, receiverId) => {
        if (!measured.has(receiverId)) return;
        edges.push({
          sender: senderId,
          receiver: receiverId,
          label: formatPortsLabel(links.values()) || undefined,
        });
      });
    });
    edges.sort((a, b) => `${a.sender}>${a.receiver}`.localeCompare(`${b.sender}>${b.receiver}`));

    return { nodes, edges };
  }

  // NOTE: A world/host/remote-node card is normally ungrouped (it has no real
  // NOTE: namespace of its own) -- except a world-split synthetic card (see
  // NOTE: world-split.ts), which inherits the reserved world label (so
  // NOTE: isWorld is still true) but is deliberately given a namespace of its
  // NOTE: own so it groups into that namespace's island instead.
  private isSpecialCard(card: ServiceCard): boolean {
    return card.namespace == null && (card.isWorld || card.isHost || card.isRemoteNode);
  }

  private isConnectedToNamespace(cardId: string, ns: string): boolean {
    const isHome = (id: string) => this.services.cardsMap.get(id)?.namespace === ns;
    let found = false;

    this.connections.outgoings.get(cardId)?.forEach((_link, receiverId) => {
      found = found || isHome(receiverId);
    });
    if (found) return true;

    this.connections.incomings.get(cardId)?.forEach((_link, senderId) => {
      found = found || isHome(senderId);
    });

    return found;
  }

  private async runLayout(input: GraphInput) {
    if (input.nodes.length === 0) return;

    if (this.isLayingOut) {
      this.pendingInput = input;
      return;
    }

    this.isLayingOut = true;
    try {
      await this.runLayoutNow(input);
    } finally {
      this.isLayingOut = false;

      if (this.pendingInput != null) {
        const next = this.pendingInput;
        this.pendingInput = null;
        void this.runLayout(next);
      }
    }
  }

  private async runLayoutNow(input: GraphInput) {
    const myGeneration = ++this.generation;
    const graph = buildElkGraph(input.nodes, input.edges);

    let result;
    try {
      result = await this.elk.layout(graph);
    } catch (err) {
      console.error('ElkServiceMapPlacementStrategy: layout failed', err);
      return;
    }

    // NOTE: A newer layout run was started (or reset() was called) while we
    // NOTE: were awaiting this one -- drop this stale result.
    if (myGeneration !== this.generation) return;

    const { positions, namespaceBBoxes, edgeRoutes } = flattenElkLayout(result);

    runInAction(() => {
      // NOTE: cardsXYs/cardsWHs (inherited from PlacementStrategy) are
      // NOTE: otherwise only ever cleared wholesale on reset() -- a card that
      // NOTE: drops out of the graph entirely (a real pod that gets
      // NOTE: rescheduled under a new name, a world-split card whose
      // NOTE: namespace/direction stops recurring) would sit in both maps
      // NOTE: forever otherwise, growing without bound for as long as the tab
      // NOTE: stays open. input.nodes is this run's complete, authoritative
      // NOTE: layout membership.
      // NOTE: cardsXYs always prunes strictly by `keep` -- a position is only
      // NOTE: ever valid for the run that computed it, and cardsBBoxes (wh +
      // NOTE: xy both present) is exactly what MapElements uses to decide a
      // NOTE: card is "sized" and belongs in the visible bucket, so a stale
      // NOTE: xy left behind for a now-hidden card would incorrectly show it
      // NOTE: at an old position.
      // NOTE: cardsWHs is pruned more leniently: a card can be legitimately
      // NOTE: absent from `input.nodes` while still very much alive --
      // NOTE: namespace-filtered-out, or the inactive variant of a "Group
      // NOTE: world cards" merge group (world-split.ts's hiddenIds) -- and
      // NOTE: since it has no xy either way (so can never render), keeping
      // NOTE: its last known size around is exactly what lets it reappear
      // NOTE: without waiting on a fresh ResizeObserver round-trip the
      // NOTE: moment it's shown again. Only prune wh for ids that have
      // NOTE: dropped out of cardsList itself, i.e. are genuinely gone.
      const keep = new Set(input.nodes.map(n => n.id));
      const stillTracked = new Set(this.cardsList.map(c => c.id));
      this.cardsXYs.forEach((_xy, id) => {
        if (!keep.has(id)) this.cardsXYs.delete(id);
      });
      this.cardsWHs.forEach((_wh, id) => {
        if (!keep.has(id) && !stillTracked.has(id)) this.cardsWHs.delete(id);
      });

      positions.forEach((xy, id) => {
        this.cardsXYs.set(id, xy);
      });
      this._namespaceBBoxes = namespaceBBoxes;
      this._edgeRoutes = edgeRoutes;
    });
  }

  // NOTE: Replaces each world card with one synthetic card per sender
  // NOTE: namespace it has buffered flow data for (see world-split.ts), and
  // NOTE: rebuilds connections from the synthetic links -- everything
  // NOTE: downstream (this class's own graphInput, and
  // NOTE: ServiceMapArrowStrategy) reads cardsList/connections rather than
  // NOTE: the store directly, so both see the same split graph.
  // NOTE: When worldSplitter.apply() detects no structural change (the very
  // NOTE: common case of a flow only updating an existing link's counters),
  // NOTE: it returns the *same* result object as last time -- this reuses
  // NOTE: that reference-stable cardsList/connections pair instead of
  // NOTE: rebuilding LinkConnections from it regardless, so cardsList/
  // NOTE: connections below (and everything reading them, e.g. graphInput)
  // NOTE: see no change via MobX's own (reference-equality) computed
  // NOTE: memoization and correctly skip relayout/remeasurement.
  private lastSplit: WorldSplitResult | null = null;
  private lastEffectiveGraphData: {
    cardsList: ServiceCard[];
    connections: LinkConnections;
    hiddenIds: Set<string>;
  } | null = null;

  @computed
  private get effectiveGraphData(): {
    cardsList: ServiceCard[];
    connections: LinkConnections;
    hiddenIds: Set<string>;
  } {
    const split = this.worldSplitter.apply(
      this.services.cardsList,
      this.interactions.connections.linksList,
      this.interactions.flows,
      this.controls.groupWorldCards,
    );

    if (split === this.lastSplit && this.lastEffectiveGraphData != null) {
      return this.lastEffectiveGraphData;
    }

    this.lastSplit = split;
    this.lastEffectiveGraphData = {
      cardsList: split.cardsList,
      connections: LinkConnections.buildFromLinks(split.links),
      hiddenIds: split.hiddenIds,
    };

    return this.lastEffectiveGraphData;
  }

  @computed
  public get cardsList(): ServiceCard[] {
    return this.effectiveGraphData.cardsList;
  }

  @computed
  public get connections(): LinkConnections {
    return this.effectiveGraphData.connections;
  }

  // NOTE: Ids currently present in cardsList but deliberately not laid out --
  // NOTE: the inactive variant (raw pair vs merged) of a "Group world cards"
  // NOTE: merge group. graphInput excludes these the same way it already
  // NOTE: excludes a namespace-filtered-out card.
  @computed
  private get hiddenCardIds(): Set<string> {
    return this.effectiveGraphData.hiddenIds;
  }
}
