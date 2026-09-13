import { XY, Vec2, Line2, utils as geomUtils } from '~/domain/geometry';
import { ArrowPort, ServiceMapArrow } from '~/ui-layer/service-map/coordinates/arrow';

import { chunks } from '~/utils/iter-tools';
import { sizes } from '~/ui/vars';
import * as protocolHelpers from '~/domain/helpers/protocol';

// NOTE: ArrowHandle is a small triangle rendered on the middle of the arrow
export type ArrowHandle = [Vec2, Vec2];

const MAX_LABEL_PORTS = 5;

// NOTE: Collapses an arrow's aggregated ports into a short label, one port
// NOTE: per line (e.g. ["8080/tcp", "51820/udp"]) rather than one comma-joined
// NOTE: line -- a label a few lines tall costs far less horizontal space on a
// NOTE: busy map than one wide line would.
export const formatPortsLabelLines = (ports: ArrowPort[]): string[] => {
  const parts = ports.map(p => protocolHelpers.formatPortProtocol(p.port, p.protocol));

  if (parts.length > MAX_LABEL_PORTS) {
    return [...parts.slice(0, MAX_LABEL_PORTS), `+${parts.length - MAX_LABEL_PORTS}`];
  }

  return parts;
};

// NOTE: Handle is created for each segment of arrow path if length of
// NOTE: the segment >= sizes.arrowHandleWidth (i e if it is long enough)
export const collectHandles = (arrow: ServiceMapArrow): ArrowHandle[] => {
  const points = arrow.points;
  if (points.length < 2) return [];

  const handles: ArrowHandle[] = [];
  chunks(points, 2, 1).forEach(([start, end], i: number, n: number) => {
    if (i === n - 1) return;
    if (geomUtils.distance(start, end) < sizes.minArrowLength) return;

    const startVec = Vec2.fromXY(start);
    const endVec = Vec2.fromXY(end);

    const mid = startVec.linterp(endVec, 0.5);
    const direction = endVec.sub(startVec).normalize();

    if (direction.isZero()) return;

    const handleLength = sizes.arrowHandleWidth;
    const handleFrom = mid.sub(direction.mul(handleLength / 2));
    const handleTo = mid.add(direction.mul(handleLength / 2));

    handles.push([handleFrom, handleTo]);
  });

  return handles;
};

// NOTE: One handle pointing out of the sender, one pointing into the
// NOTE: receiver -- rendered regardless of segment length (unlike
// NOTE: collectHandles above) so every line shows which way traffic flows
// NOTE: even when too short for a midline handle to fit.
export const collectEndpointHandles = (arrow: ServiceMapArrow): ArrowHandle[] => {
  const points = arrow.points;
  if (points.length < 2) return [];

  const handles: ArrowHandle[] = [];
  const maxLength = sizes.arrowHandleWidth;

  const handleAt = (a: XY, b: XY, fromStart: boolean): ArrowHandle | null => {
    const start = Vec2.fromXY(a);
    const end = Vec2.fromXY(b);
    const direction = end.sub(start).normalize();
    if (direction.isZero()) return null;

    const length = Math.min(maxLength, start.distance(end));
    const anchor = fromStart
      ? start.add(direction.mul(length / 2))
      : end.sub(direction.mul(length / 2));

    return [anchor.sub(direction.mul(length / 2)), anchor.add(direction.mul(length / 2))];
  };

  const startHandle = handleAt(points[0], points[1], true);
  if (startHandle != null) handles.push(startHandle);

  const endHandle = handleAt(points[points.length - 2], points[points.length - 1], false);
  if (endHandle != null) handles.push(endHandle);

  return handles;
};

export const arrowHandleId = (handle: ArrowHandle, arrow: ServiceMapArrow): string => {
  const [from, to] = handle;
  const mid = geomUtils.linterp2(from, to, 0.5);

  // WARN: precision lose here
  return `${arrow.id}-${Math.trunc(mid.x)},${Math.trunc(mid.y)}`;
};

const arrowHandlePath = (handle: ArrowHandle | null): string => {
  if (handle == null) return '';

  const [start, end] = handle;
  const width = start.distance(end);

  const line = Line2.throughPoints(start, end);
  const side = line.normal.mul(width / 2);

  const baseA = start.add(side);
  const baseB = start.sub(side);

  const sweep = geomUtils.pointSideOfLine(start, end, baseA) > 0 ? 0 : 1;

  const r = 2;
  const [ar1, ar2] = geomUtils.roundCorner(r, [start, baseA, end]);
  const [br1, br2] = geomUtils.roundCorner(r, [start, baseB, end]);
  const [er1, er2] = geomUtils.roundCorner(r, [baseA, end, baseB]);

  return `
    M ${start.x} ${start.y}
    L ${ar1.x} ${ar1.y}
    A ${r} ${r} 0 0 ${sweep} ${ar2.x} ${ar2.y}
    L ${er1.x} ${er1.y}
    A ${r} ${r} 0 0 ${sweep} ${er2.x} ${er2.y}
    L ${br2.x} ${br2.y}
    A ${r} ${r} 0 0 ${sweep} ${br1.x} ${br1.y}
    Z
  `;
};

const arrowLinePath = (points: XY[]): string => {
  if (points.length < 2) return '';

  if (points.length === 2) {
    const [a, b] = points;
    return `M ${a.x} ${a.y} L${b.x} ${b.y}`;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const r = sizes.arrowRadius;

  let line = `M ${first.x} ${first.y}`;

  chunks(points, 3, 2).forEach((chunk: XY[]) => {
    const [a, b, c] = chunk;
    let [d, e, angle] = geomUtils.roundCorner(r, [a, b, c]);

    // roundCorner signals "there's no real corner to round here" (points
    // coincide, or a segment was too short to round safely) by returning
    // Math.PI with d/e set to the chunk's own endpoints -- drawing an SVG
    // arc between those is wrong whenever they're not close together (SVG
    // scales the radius up to reach them, producing a huge stray loop).
    // Go straight there instead.
    if (angle >= Math.PI - Number.EPSILON) {
      line += `L ${e.x} ${e.y}`;
      return;
    }

    // This case occurs much more rarely than others, so using roundCorner
    // one more time is ok since angle computaion is part of entire function
    if (angle < Math.PI / 4) {
      [d, e, angle] = geomUtils.roundCorner(r * Math.sin(angle), [a, b, c]);
    }

    const ab = Vec2.from(b.x - a.x, b.y - a.y);
    const bc = Vec2.from(c.x - b.x, c.y - b.y);
    const sweep = ab.isClockwise(bc) ? 0 : 1;

    line += `
      L ${d.x} ${d.y}
      A ${r} ${r} 0 0 ${sweep} ${e.x} ${e.y}
    `;
  });

  line += `L ${last.x} ${last.y}`;
  return line;
};

export const svg = {
  arrowHandlePath,
  arrowLinePath,
};
