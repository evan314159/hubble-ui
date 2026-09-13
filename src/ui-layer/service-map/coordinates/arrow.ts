import { action, actionBound, computed, observable } from 'mobx';

import { AuthType, IPProtocol, LinkThroughput, Verdict } from '~/domain/hubble';
import { Vec2, XY, XYWH, rounding, utils as gutils } from '~/domain/geometry';

import { sizes } from '~/ui';
import { Arrow } from '~/ui/layout/abstract/arrows';

import { CardOffsets } from './helpers/card-offsets';

export interface ArrowPort {
  port: number;
  protocol: IPProtocol;
}

export class ServiceMapArrow extends Arrow {
  @observable
  public accessor senderId: string | null = null;
  public senderBBox: XYWH | null = null;

  @observable
  public accessor receiverId: string | null = null;
  public receiverBBox: XYWH | null = null;

  @observable
  private accessor _flowsInfoIndicatorCoords: XY | null = null;

  @observable
  private accessor _linkThroughputs: LinkThroughput[] = [];

  // NOTE: Aggregated across every access point this sender talks to this
  // NOTE: receiver on -- see the "one line + label" decision in arrows.ts:
  // NOTE: this arrow no longer routes a separate line into each port, so
  // NOTE: verdicts/ports/auth need to live on the trunk itself instead of a
  // NOTE: per-port sub-arrow.
  @observable
  public accessor verdicts: Set<Verdict> = new Set();

  @observable
  public accessor authTypes: Set<AuthType> = new Set();

  @observable
  public accessor isEncrypted = false;

  @observable
  private accessor _ports: Map<string, ArrowPort> = new Map();

  // NOTE: Past sizes.arrowHandleWidth so the label doesn't sit on top of (and
  // NOTE: hide) the endpoint arrowhead near the terminating node.
  public static readonly flowsIndicatorOffset = sizes.arrowHandleWidth + 20;

  public static new(): ServiceMapArrow {
    return new ServiceMapArrow();
  }

  constructor() {
    super();
  }

  @action
  public from(senderId: string, bbox?: XYWH): this {
    this.senderId = senderId;
    this.senderBBox = bbox || null;
    return this;
  }

  @action
  public to(receiverId: string, bbox?: XYWH): this {
    this.receiverId = receiverId;
    this.receiverBBox = bbox || null;
    return this;
  }

  @action
  public addLinkThroughput(lt: LinkThroughput): this {
    this._linkThroughputs.push(lt);
    return this;
  }

  @action
  public addVerdicts(verdicts: Set<Verdict>): this {
    verdicts.forEach(v => this.verdicts.add(v));
    return this;
  }

  @action
  public addAuthTypes(authTypes: Set<AuthType>): this {
    authTypes.forEach(at => this.authTypes.add(at));
    return this;
  }

  @action
  public setEncryption(encryption: boolean): this {
    this.isEncrypted = this.isEncrypted || encryption;
    return this;
  }

  @action
  public addPort(port: number, protocol: IPProtocol): this {
    this._ports.set(`${port}/${protocol}`, { port, protocol });
    return this;
  }

  @computed
  public get ports(): ArrowPort[] {
    return Array.from(this._ports.values());
  }

  @computed
  public get hasAbnormalVerdict(): boolean {
    return this.verdicts.has(Verdict.Dropped) || this.verdicts.has(Verdict.Error);
  }

  @computed
  public get hasAuth(): boolean {
    return this.authTypes.has(AuthType.Spire);
  }

  @action
  public buildPointsAroundSenderAndReceiver(offsets: CardOffsets): this {
    // prettier-ignore
    const start = this.start, end = this.end;

    if (
      start == null ||
      end == null ||
      this.senderId == null ||
      this.receiverId == null ||
      this.senderBBox == null ||
      this.receiverBBox == null
    )
      return this;

    const startPoint = Vec2.fromXY(start);
    const endPoint = Vec2.fromXY(end);

    const shiftedStart = startPoint.add({ x: sizes.connectorCardStartGap, y: 0 });
    const shiftedEnd = endPoint.sub({ x: sizes.connectorCardStartGap, y: 0 });

    const receiverIsOnTheLeft = startPoint.x > endPoint.x;
    // NOTE: Receiver card is in front of sender card, so no workaround required
    if (!receiverIsOnTheLeft) {
      this._points.splice(1, 0, shiftedStart, shiftedEnd);
      return this;
    }

    // NOTE: At first, go around the sender bbox
    // TODO: Should we add offsets.around.advance(this.senderId) to padding ?
    const points1 = rounding.goAroundTheBox(
      this.senderBBox,
      shiftedStart,
      shiftedEnd,
      sizes.aroundCardPadX,
      sizes.aroundCardPadY,
    );

    // NOTE: Take the point that is placed after the sender bbox. From this
    // NOTE: point when going towards the receiver, it's impossible to face
    // NOTE: the sender bbox. This point is always defined.
    const senderPoint = points1.at(-1) ?? shiftedStart;
    const aroundOffset = offsets.around.advance(this.receiverId);

    // NOTE: Now we are going around the second box
    const points2 = rounding.goAroundTheBox(
      this.receiverBBox,
      senderPoint,
      shiftedEnd,
      sizes.aroundCardPadX + aroundOffset,
      sizes.aroundCardPadY + aroundOffset,
    );

    // NOTE: We incremented an around offset for receiver before trying to go
    // NOTE: around, but in case when there was no need to go around, we must
    // NOTE: rewind (rollback) the offset counter.
    if (points2.length === 0) offsets.around.rewind(this.receiverId);

    // NOTE: If we went around the receiver box, then the last "around" point
    // NOTE: and shiftedEnd point is not vertically aligned, let's fix it:
    if (points2.length > 0) {
      const lastAroundPoint = points2.at(-1)!;
      const offsetAdvancer = lastAroundPoint.y > senderPoint.y ? offsets.bottom : offsets.top;

      const offset = offsetAdvancer.advance(this.receiverId);

      // TODO: This is not fair offset in case when receiver != sender, thus
      // TODO: vector prolongation should be used.
      // NOTE: Align those two points vertically for better view
      lastAroundPoint.x = end.x - offset;
      shiftedEnd.x = end.x - offset;
    }

    // NOTE: Just put those shifted points + around points from first walk
    // NOTE: in the middle of the start and end.
    this._points.splice(1, 0, shiftedStart, ...points1, ...points2, shiftedEnd);
    this._points = this.removeSharpAngleAtConnector(this._points);

    return this;
  }

  // NOTE: Alternative to buildPointsAroundSenderAndReceiver() that uses an
  // NOTE: externally-computed route (elkjs's orthogonal edge routing) for the
  // NOTE: trunk instead of the manual box-avoidance logic above. This is the
  // NOTE: route's own start and end, not a fixed point on the card shared by
  // NOTE: every edge that touches it -- ELK already picks a sensible,
  // NOTE: per-edge boundary position for each of a node's many edges, and
  // NOTE: overriding that with one shared point is what produced a fan of
  // NOTE: diagonal lines into busy nodes. The line exits/enters the node
  // NOTE: directly, wherever ELK put it.
  @action
  public useExternalRoute(route: XY[]): this {
    if (route.length === 0) return this;

    this._points = this.removeSharpAngleAtConnector([...route]);

    return this;
  }

  // NOTE: Retargets this route's final approach to a shared x so multiple
  // NOTE: senders converge on one entry point instead of each landing at its
  // NOTE: own ELK-picked spot along the receiver's edge.
  @action
  public snapEntryX(x: number): this {
    const pts = this._points;
    const n = pts.length;
    if (n < 2) return this;

    const last = pts[n - 1];
    const prev = pts[n - 2];
    const prevIsHorizontalBend = n >= 3 && Math.abs(prev.y - pts[n - 3].y) < Number.EPSILON;

    if (prevIsHorizontalBend) {
      pts[n - 2] = { x, y: prev.y };
      pts[n - 1] = { x, y: last.y };
    } else {
      pts.splice(n - 1, 0, { x, y: prev.y });
      pts[pts.length - 1] = { x, y: last.y };
    }

    this._points = this.dedupeConsecutivePoints(this._points);

    return this;
  }

  // NOTE: Collapsing two routes onto a shared entry x can make an already-
  // NOTE: degenerate bend (one whose height already matched the endpoint's)
  // NOTE: fully coincide with it, leaving a zero-length final segment with no
  // NOTE: direction to point an arrowhead along.
  private dedupeConsecutivePoints(points: XY[]): XY[] {
    return points.filter((p, i) => {
      const prev = points[i - 1];
      if (prev == null) return true;

      return Math.abs(prev.x - p.x) > Number.EPSILON || Math.abs(prev.y - p.y) > Number.EPSILON;
    });
  }

  // NOTE: Anchored at the line's true end point, not an earlier bend, so the
  // NOTE: label sits a uniform distance from the node it terminates at.
  // NOTE: offsetMultiplier lets a busy receiver (e.g. a world card with many
  // NOTE: incoming arrows) stagger labels at varying distances so adjacent
  // NOTE: ones don't render on top of each other -- see declutterFlowsIndicators.
  @actionBound
  public computeFlowsInfoIndicatorPosition(offsetMultiplier = 1) {
    const end = this._points.at(-1);
    const beforeEnd = this._points.at(-2);

    if (end == null || beforeEnd == null) return;

    const direction = Vec2.fromXY(beforeEnd).sub(end).normalize();
    if (direction.isZero()) return;

    this._flowsInfoIndicatorCoords = Vec2.fromXY(end)
      .addInPlace(direction.mul(ServiceMapArrow.flowsIndicatorOffset * offsetMultiplier))
      .xy();
  }

  @computed
  public get id(): string {
    return `${this.senderId ?? ''} -> ${this.receiverId ?? ''}`;
  }

  @computed
  public get linkThroughputs(): LinkThroughput[] {
    return this._linkThroughputs.slice();
  }

  @computed
  public get flowsInfoIndicatorCoords(): XY | null {
    if (this._flowsInfoIndicatorCoords == null) return null;

    return {
      x: this._flowsInfoIndicatorCoords.x,
      y: this._flowsInfoIndicatorCoords.y,
    };
  }

  @action
  private removeSharpAngleAtConnector(points: XY[]) {
    // NOTE: useExternalRoute() no longer pads the route with separate fixed
    // NOTE: start/end points first, so a route with no interior bends (just
    // NOTE: its own start+end) can be as short as 2 points here.
    if (points.length < 3) return points;

    // Check angle between last two segments of arrow to avoid sharp angle
    // on connector
    const [a, b, c] = points.slice(points.length - 3);
    const angleThreshold = Math.PI / 9;
    const angle = gutils.angleBetweenSegments(a, b, c);

    if (angle > angleThreshold) return points;

    points.splice(points.length - 2, 1);
    return points;
  }
}
