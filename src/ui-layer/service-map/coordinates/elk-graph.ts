import ELK, { ElkNode } from 'elkjs/lib/elk.bundled.js';

import { XY, XYWH } from '~/domain/geometry';
import { sizes } from '~/ui/vars';

export interface ElkNodeInput {
  id: string;
  w: number;
  h: number;
  // NOTE: null means "don't group this node into a namespace island"
  // NOTE: (world / host cards).
  namespace: string | null;
}

export interface ElkEdgeInput {
  sender: string;
  receiver: string;
  // NOTE: When set, ELK reserves space for this text along the edge and
  // NOTE: picks where it goes (avoiding other nodes/edges), rather than us
  // NOTE: guessing a position after the fact.
  label?: string;
}

// NOTE: Top padding needs more room than bottom: many edges (every sender
// NOTE: reaching this island's topmost node, e.g. a world card) converge on
// NOTE: the same entry point, and a world card in particular can grow tall
// NOTE: (up to MAX_DESTINATIONS lines) -- too little padding here reads as
// NOTE: pass-through lines and the namespace's own border crowding the card.
const GROUP_PAD_TOP = 45;
const GROUP_PAD_BOTTOM = 10;
const GROUP_PAD_SIDE = 20;

export interface ElkLayoutResult {
  positions: Map<string, XY>;
  namespaceBBoxes: Map<string, XYWH>;
  // NOTE: { "<senderId>-><receiverId>" -> orthogonal route points }
  edgeRoutes: Map<string, XY[]>;
}

// NOTE: Rough text-size estimate so ELK reserves enough (but not much more
// NOTE: than) the space this label will actually need -- matches the
// NOTE: font/size used to render it in ServiceMapArrowBody. The label is
// NOTE: rendered one port per line (see formatPortsLabelLines) rather than
// NOTE: joined onto one line, so width comes from the longest line and height
// NOTE: grows with the number of lines instead of the other way around --
// NOTE: that's the whole point, since horizontal space is at a premium on a
// NOTE: busy map.
export function estimateLabelSize(text: string): { width: number; height: number } {
  const lines = text.split('\n');
  const longest = lines.reduce((max, line) => Math.max(max, line.length), 0);

  return { width: longest * 6 + 8, height: lines.length * 14 };
}

export function edgeRouteKey(senderId: string, receiverId: string): string {
  return `${senderId}->${receiverId}`;
}

export function buildElkGraph(nodes: ElkNodeInput[], edges: ElkEdgeInput[]): ElkNode {
  const byNamespace = new Map<string, ElkNode[]>();
  const top: ElkNode[] = [];

  nodes.forEach(n => {
    const child: ElkNode = { id: n.id, width: n.w, height: n.h };

    if (n.namespace == null) {
      top.push(child);
      return;
    }

    if (!byNamespace.has(n.namespace)) byNamespace.set(n.namespace, []);
    byNamespace.get(n.namespace)!.push(child);
  });

  const groups: ElkNode[] = Array.from(byNamespace.entries()).map(([ns, children]) => ({
    id: `ns:${ns}`,
    labels: [{ text: ns, width: ns.length * 7 + 10, height: 14 }],
    layoutOptions: {
      'elk.algorithm': 'layered',
      // NOTE: Bottom-to-top, matching hubble-ui's historical convention:
      // NOTE: senders below, receivers above.
      'elk.direction': 'UP',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': `[top=${GROUP_PAD_TOP},left=${GROUP_PAD_SIDE},bottom=${GROUP_PAD_BOTTOM},right=${GROUP_PAD_SIDE}]`,
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.spacing.nodeNode': '50',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      // NOTE: An edge to a same-layer-but-different-column sibling (e.g.
      // NOTE: immich -> machine-learning, both fed by the same layer as
      // NOTE: immich -> redis/postgres) jogs sideways in the corridor between
      // NOTE: layers -- without this ELK's tight default let that horizontal
      // NOTE: segment run right along the top of the sender's own box instead
      // NOTE: of clearing it first.
      'elk.layered.spacing.edgeNodeBetweenLayers': '20',
      // NOTE: Spacing between edges sharing the same inter-layer corridor --
      // NOTE: with direction UP this is what keeps two horizontal jog
      // NOTE: segments (an orthogonal edge sidestepping to line up with a
      // NOTE: target at a different x) from packing in right next to each
      // NOTE: other; ELK's own default here is quite tight.
      'elk.layered.spacing.edgeEdgeBetweenLayers': '60',
      // NOTE: The *BetweenLayers spacings above only govern the corridor
      // NOTE: between layers -- they say nothing about how tightly several
      // NOTE: edges pack onto the same node's own face (e.g. every sender
      // NOTE: reaching a namespace's topmost node, like an ingress or
      // NOTE: operator pod fed by several world/pod senders at once) or how
      // NOTE: close two edges run alongside each other *within* one layer.
      // NOTE: Both default quite tight in ELK, which is what read as lines
      // NOTE: and their labels crowding right on top of a node's border.
      'elk.spacing.portPort': '20',
      'elk.spacing.edgeNode': '20',
      'elk.spacing.edgeEdge': '20',
      // NOTE: Two raw world-identity cards (world-ipv4/world-ipv6, when not
      // NOTE: merged) that both talk to the same target on the same port
      // NOTE: produce two edges with identical label text landing at nearly
      // NOTE: the same point under HEAD placement -- these two spacings push
      // NOTE: those labels (and the labels vs. the lines/nodes around them)
      // NOTE: apart instead of letting them print on top of each other.
      'elk.spacing.labelLabel': '6',
      'elk.spacing.edgeLabel': '10',
      'elk.nodeLabels.placement': '[H_LEFT, V_TOP, OUTSIDE]',
      'elk.edgeLabels.placement': 'HEAD',
    },
    children,
  }));

  // NOTE: Map/index.tsx draws each island's backplate `sizes
  // NOTE: .namespaceBackplatePadding` (M) beyond the ELK-computed group box,
  // NOTE: whose own edge already sits GROUP_PAD_SIDE (G) beyond its pods --
  // NOTE: so the visual gap from a pod to its own island's border is G + M.
  // NOTE: The gap between two neighboring islands' borders is instead
  // NOTE: (this spacing, edge-to-edge between their raw ELK boxes) minus 2M
  // NOTE: (each backplate eats into the gap by M on its own side). Solving
  // NOTE: for the spacing that makes those two gaps equal keeps padding
  // NOTE: consistent whether you're looking at pod<->island or
  // NOTE: island<->island: T - 2M = G + M -> T = G + 3M.
  const topLevelSpacing = `${GROUP_PAD_SIDE + 3 * sizes.namespaceBackplatePadding}`;
  // NOTE: elk.direction: UP means "between layers" is the vertical (north-
  // NOTE: south) gap and "nodeNode" is the horizontal (east-west) gap between
  // NOTE: same-layer siblings. Both used to share topLevelSpacing, but ELK
  // NOTE: reserves additional room on top of the between-layers number for
  // NOTE: orthogonal edge routing and edge labels passing through that gap --
  // NOTE: space the horizontal gap never needs, since same-layer siblings
  // NOTE: aren't connected by an edge routed between them. That made the
  // NOTE: vertical gap end up visibly larger than the horizontal one even
  // NOTE: though both were configured with the same number, so the vertical
  // NOTE: figure is knocked down to compensate -- by less than the full 2M
  // NOTE: the horizontal one gets, since ELK's own reserved edge/label room
  // NOTE: makes up part of the difference on its own.
  const topLevelVerticalSpacing = `${GROUP_PAD_SIDE + 2 * sizes.namespaceBackplatePadding}`;
  // NOTE: edgeNodeBetweenLayers stacks additively on top of
  // NOTE: nodeNodeBetweenLayers (both reserve room in the same vertical gap),
  // NOTE: so reusing topLevelVerticalSpacing here nearly doubled the vertical
  // NOTE: gap -- this only needs to be enough to push a pass-through edge
  // NOTE: clear of a sibling island's box, not another full copy of the
  // NOTE: island spacing itself.
  const topLevelVerticalEdgeSpacing = `${GROUP_PAD_SIDE + 1.5 * sizes.namespaceBackplatePadding}`;

  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'UP',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
      'elk.layered.spacing.nodeNodeBetweenLayers': topLevelVerticalSpacing,
      'elk.spacing.nodeNode': topLevelSpacing,
      // NOTE: A cross-namespace edge (or one to/from a top-level world/host
      // NOTE: card) passing through a layer a sibling namespace island
      // NOTE: occupies is only guaranteed a lane in that layer, not real
      // NOTE: clearance from the island's own (possibly wide) box -- these
      // NOTE: push the routed line further from any island it doesn't
      // NOTE: actually connect to, on top of ELK's otherwise fairly tight
      // NOTE: defaults, so it reads more clearly as passing *around* that
      // NOTE: island rather than over it.
      'elk.spacing.edgeNode': topLevelSpacing,
      'elk.layered.spacing.edgeNodeBetweenLayers': topLevelVerticalEdgeSpacing,
      // NOTE: Spacing between edges sharing the same inter-layer corridor --
      // NOTE: see the namespace-group layoutOptions above for why this needs
      // NOTE: to be explicit instead of ELK's own (tight) default.
      'elk.layered.spacing.edgeEdgeBetweenLayers': '60',
      // NOTE: HEAD = near the target/receiving end of the edge, not centered
      // NOTE: along its full length -- the label should read like it
      // NOTE: belongs to the port it's arriving at.
      'elk.edgeLabels.placement': 'HEAD',
    },
    children: [...top, ...groups],
    edges: edges.map((edge, i) => ({
      id: `e${i}`,
      sources: [edge.sender],
      targets: [edge.receiver],
      labels: edge.label ? [{ text: edge.label, ...estimateLabelSize(edge.label) }] : undefined,
    })),
  };
}

export function flattenElkLayout(result: ElkNode): ElkLayoutResult {
  const positions = new Map<string, XY>();
  const namespaceBBoxes = new Map<string, XYWH>();
  const edgeRoutes = new Map<string, XY[]>();

  // NOTE: elkjs leaves every edge in whichever node's `edges` array it was
  // NOTE: originally declared on (for us, always the root) -- it does NOT
  // NOTE: move hierarchical edges into a nested group's own edge list. What
  // NOTE: it *does* do is tag each edge with `container`: the id of the node
  // NOTE: whose coordinate system its `sections` points are actually
  // NOTE: relative to (the lowest common ancestor of the edge's two
  // NOTE: endpoints). So an edge between two pods inside the same namespace
  // NOTE: island is still found in the root's edge array, but its points are
  // NOTE: relative to that island's origin, not the root's -- using the
  // NOTE: offset of whatever node we found the edge's *array* on (as a
  // NOTE: previous version of this code did) silently applied the wrong
  // NOTE: offset for every edge fully contained inside a namespace, leaving
  // NOTE: their rendered lines short of (or beyond) the nodes they connect.
  const containerOffsets = new Map<string, XY>([['root', { x: 0, y: 0 }]]);
  const allEdges: NonNullable<ElkNode['edges']> = [];

  function walk(node: ElkNode, ox: number, oy: number) {
    (node.children || []).forEach(child => {
      const cx = ox + (child.x || 0);
      const cy = oy + (child.y || 0);
      const isGroup = !!(child.children && child.children.length);

      if (isGroup) {
        const ns = child.id.replace(/^ns:/, '');
        namespaceBBoxes.set(ns, new XYWH(cx, cy, child.width || 0, child.height || 0));
        containerOffsets.set(child.id, { x: cx, y: cy });
        walk(child, cx, cy);
      } else {
        positions.set(child.id, { x: cx, y: cy });
      }
    });

    (node.edges || []).forEach(edge => allEdges.push(edge));
  }

  walk(result, 0, 0);

  allEdges.forEach(edge => {
    const senderId = edge.sources?.[0];
    const receiverId = edge.targets?.[0];
    if (senderId == null || receiverId == null) return;

    const { x: ox, y: oy } = containerOffsets.get(edge.container ?? 'root') ?? { x: 0, y: 0 };

    const points: XY[] = [];
    (edge.sections || []).forEach(sec => {
      points.push({ x: sec.startPoint.x + ox, y: sec.startPoint.y + oy });
      (sec.bendPoints || []).forEach(p => points.push({ x: p.x + ox, y: p.y + oy }));
      points.push({ x: sec.endPoint.x + ox, y: sec.endPoint.y + oy });
    });

    if (points.length > 0) edgeRoutes.set(edgeRouteKey(senderId, receiverId), points);
  });

  return { positions, namespaceBBoxes, edgeRoutes };
}

export function createElk() {
  return new ELK();
}
