import { computed, observable } from 'mobx';

import { ArrowStrategy, ArrowsMap } from '~/ui/layout/abstract';

import { ServiceMapPlacement } from './placement';
import { ServiceMapArrow } from './arrow';
import { createCardOffsetAdvancers } from './helpers';

// NOTE: This strategy determines coords of arrows that are to be rendered on
// NOTE: ServiceMap. There's one arrow per (sender, receiver) pair -- ports,
// NOTE: protocols, verdicts etc. across every access point that pair talks
// NOTE: over are aggregated onto that single arrow (see ServiceMapArrow) and
// NOTE: shown as a label, rather than routing a separate line into each port.
export class ServiceMapArrowStrategy extends ArrowStrategy {
  @observable
  private accessor placement: ServiceMapPlacement;

  constructor(placement: ServiceMapPlacement) {
    super();
    this.placement = placement;
  }

  // NOTE: The base class's `arrows` reads from `_arrows`, a plain observable
  // NOTE: field that only a manual rebuild() ever wrote to -- rebuild() was
  // NOTE: called solely from RefsCollector's resize-driven onCoordsUpdated
  // NOTE: handler, so an ELK relayout that only *moves* already-correctly-
  // NOTE: sized cards (no resize involved) never refreshed it, leaving arrows
  // NOTE: drawn from stale pre-relayout positions until some unrelated card
  // NOTE: happened to resize. arrowsMap is already a proper computed over the
  // NOTE: live cardsBBoxes/connections/edgeRoutes -- returning it directly
  // NOTE: makes `arrows` correct by construction instead of by remembering to
  // NOTE: call rebuild() at every place cards could move.
  @computed
  public override get arrows(): ArrowsMap {
    return new Map(this.arrowsMap);
  }

  @computed
  public get arrowsMap(): Map<string, ServiceMapArrow> {
    const arrows: Map<string, ServiceMapArrow> = new Map();
    const bboxes = this.placement.cardsBBoxes;

    this.connections.outgoings.forEach((receivers, senderId) => {
      const senderBBox = bboxes.get(senderId);
      if (senderBBox == null) return;

      receivers.forEach((links, receiverId) => {
        const receiverBBox = bboxes.get(receiverId);
        if (receiverBBox == null) return;

        const arrow = ServiceMapArrow.new().from(senderId, senderBBox).to(receiverId, receiverBBox);
        arrows.set(arrow.id, arrow);

        links.forEach(link => {
          arrow
            .addLinkThroughput(link.throughput)
            .addVerdicts(link.verdicts)
            .addAuthTypes(link.authTypes)
            .setEncryption(link.isEncrypted)
            .addPort(link.destinationPort, link.ipProtocol);
        });
      });
    });

    // NOTE: Keep track of all arrows that go around sender and receiver
    // NOTE: bboxes, not to put them on overlapping parallel paths when that
    // NOTE: path goes near the edges of the card.
    const offsets = createCardOffsetAdvancers();

    arrows.forEach(arrow => {
      if (arrow.senderId == null || arrow.receiverId == null) return;
      if (arrow.senderBBox == null || arrow.receiverBBox == null) return;

      const route = this.placement.getEdgeRoute(arrow.senderId, arrow.receiverId);

      if (route != null && route.length > 0) {
        // NOTE: Each edge gets its own ELK-picked boundary point, not one
        // NOTE: point shared by every edge touching the card -- the latter
        // NOTE: fans out diagonally on nodes with many edges.
        arrow.useExternalRoute(route);
      } else {
        // NOTE: elk.layout() is async -- this is a transient fallback for the
        // NOTE: gap between a new edge showing up in `connections` and the
        // NOTE: next layout run resolving with its route. Bottom-to-top exit/
        // NOTE: enter, matching this strategy's layout direction.
        const senderBBox = arrow.senderBBox;
        const receiverBBox = arrow.receiverBBox;

        const start = { x: senderBBox.x + senderBBox.w / 2, y: senderBBox.y };
        const end = { x: receiverBBox.x + receiverBBox.w / 2, y: receiverBBox.y + receiverBBox.h };

        arrow.addPoint(start).addPoint(end).buildPointsAroundSenderAndReceiver(offsets);
      }
    });

    this.mergeEntriesBySamePort(arrows);
    this.declutterFlowsIndicators(arrows);

    return arrows;
  }

  // NOTE: A busy receiver (e.g. a world card aggregating many senders) can
  // NOTE: have several arrows land close together along one edge -- stagger
  // NOTE: each label's distance from the node, cycling through a few
  // NOTE: multipliers by entry-x order, so adjacent labels don't overlap.
  private declutterFlowsIndicators(arrows: Map<string, ServiceMapArrow>) {
    const offsetMultipliers = [1, 1.8, 2.6];
    const byReceiver = new Map<string, ServiceMapArrow[]>();

    arrows.forEach(arrow => {
      if (arrow.receiverId == null) return;

      if (!byReceiver.has(arrow.receiverId)) byReceiver.set(arrow.receiverId, []);
      byReceiver.get(arrow.receiverId)!.push(arrow);
    });

    byReceiver.forEach(group => {
      if (group.length < 2) {
        group.forEach(arrow => arrow.computeFlowsInfoIndicatorPosition());
        return;
      }

      group.sort((a, b) => (a.end?.x ?? 0) - (b.end?.x ?? 0));
      group.forEach((arrow, i) => {
        arrow.computeFlowsInfoIndicatorPosition(offsetMultipliers[i % offsetMultipliers.length]);
      });
    });
  }

  // NOTE: Multiple senders reaching one receiver on the same port land at
  // NOTE: separate ELK-picked spots along its edge by default -- retarget
  // NOTE: them to a shared entry point so they visibly converge into one line.
  private mergeEntriesBySamePort(arrows: Map<string, ServiceMapArrow>) {
    const groups = new Map<string, ServiceMapArrow[]>();

    arrows.forEach(arrow => {
      if (arrow.receiverId == null || arrow.ports.length !== 1) return;

      const port = arrow.ports[0];
      const key = `${arrow.receiverId}:${port.port}/${port.protocol}`;

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(arrow);
    });

    groups.forEach(group => {
      if (group.length < 2) return;

      const xs = group.map(a => a.end?.x).filter((x): x is number => x != null);
      if (xs.length === 0) return;

      const sharedX = xs.reduce((sum, x) => sum + x, 0) / xs.length;
      group.forEach(a => a.snapEntryX(sharedX));
    });
  }

  @computed
  private get connections() {
    return this.placement.connections;
  }
}
