import React, { useCallback, useEffect, useRef } from 'react';
import { observer } from 'mobx-react-lite';
import classnames from 'classnames';
import * as d3 from 'd3';

import { XY } from '~/domain/geometry';

import { ArrowRendererProps } from '~/components/ArrowsRenderer';
import { Teleport } from '~/components/Teleport';
import { ServiceMapArrow } from '~/ui-layer/service-map/coordinates/arrow';
import { colors, sizes } from '~/ui/vars';

import * as helpers from './helpers';
import css from './styles.scss';

export type Props = ArrowRendererProps & {};

export const ServiceMapArrowBody = observer(function ServiceMapArrowBody(props: Props) {
  const trajectoryGroup = useRef<SVGGElement | null>(null);
  const handlesGroup = useRef<SVGGElement | null>(null);
  const endpointHandlesGroup = useRef<SVGGElement | null>(null);
  const labelGroup = useRef<SVGGElement | null>(null);

  const strokeColor = (arrow: ServiceMapArrow) =>
    arrow.hasAbnormalVerdict ? colors.arrowStrokeRed : colors.arrowStroke;

  const handleColor = (arrow: ServiceMapArrow) =>
    arrow.hasAbnormalVerdict ? colors.arrowStrokeRed : colors.arrowHandle;

  const renderArrow = useCallback((arrow: ServiceMapArrow) => {
    // NOTE: Here we use data bind with one element in array just to have
    // NOTE: an access to enter/update sets (see d3 General Update Pattern).
    const path = d3
      .select(trajectoryGroup.current!)
      .selectAll<SVGPathElement, ServiceMapArrow>('path.line')
      .data([arrow], d => d.id);

    // NOTE: d3 Update set is handled here
    path.attr('d', d => helpers.svg.arrowLinePath(d.points)).attr('stroke', strokeColor);

    path
      .enter()
      .append('path')
      .attr('class', 'line')
      .attr('stroke', strokeColor)
      .attr('stroke-width', sizes.linkWidth)
      .attr('fill', 'none')
      .attr('d', d => helpers.svg.arrowLinePath(d.points));

    path.exit().remove();

    // NOTE: The visible line is thin (sizes.linkWidth) -- much too thin to
    // NOTE: reliably click. This transparent, much wider twin of it (never
    // NOTE: rendered visibly) is the actual click target for the arrow.
    const hitArea = d3
      .select(trajectoryGroup.current!)
      .selectAll<SVGPathElement, ServiceMapArrow>('path.hit-area')
      .data([arrow], d => d.id);

    hitArea.attr('d', d => helpers.svg.arrowLinePath(d.points));

    hitArea
      .enter()
      .append('path')
      .attr('class', 'hit-area')
      .attr('stroke', 'transparent')
      .attr('stroke-width', sizes.linkWidth + 14)
      .attr('fill', 'none')
      .attr('d', d => helpers.svg.arrowLinePath(d.points));

    hitArea.exit().remove();
  }, []);

  // NOTE: One line per sender->receiver pair no longer routes into each
  // NOTE: individual port -- ports/protocols are summarized here instead, at
  // NOTE: the position ELK's own edge-label layout picked (or a fallback
  // NOTE: heuristic when that isn't available; see ServiceMapArrow).
  const renderPortLabel = useCallback((arrow: ServiceMapArrow) => {
    const coords = arrow.flowsInfoIndicatorCoords;
    const lines = helpers.formatPortsLabelLines(arrow.ports);

    const label = d3
      .select(labelGroup.current!)
      .selectAll<SVGTextElement, XY>('text.port-label')
      .data(coords != null && lines.length > 0 ? [coords] : [], () => `${arrow.id}-port-label`);

    // NOTE: SVG <text> ignores literal newlines -- each line needs its own
    // NOTE: <tspan>, re-x'd to the anchor and stacked with a fixed line
    // NOTE: height, to actually render as multiple lines instead of space-
    // NOTE: collapsing into one.
    const applyLines = (sel: d3.Selection<SVGTextElement, XY, SVGGElement, unknown>) => {
      sel.each(function (d) {
        const text = d3.select(this);
        text.selectAll('tspan').remove();

        lines.forEach((line, i) => {
          text
            .append('tspan')
            .attr('x', d.x)
            .attr('dy', i === 0 ? 0 : '1.2em')
            .text(line);
        });
      });
    };

    label.attr('x', d => d.x).attr('y', d => d.y);
    applyLines(label);

    const entered = label
      .enter()
      .append('text')
      .attr('class', 'port-label')
      .attr('fill', colors.arrowHandle)
      // NOTE: This sits in the same (world-space) coordinate system as the
      // NOTE: rest of the map, which is zoomed out a lot for any non-trivial
      // NOTE: graph -- sizes.arrowRadius-scale numbers (e.g. 11) become
      // NOTE: sub-pixel and disappear. Match the scale NamespaceBackplate's
      // NOTE: label uses (1.75em) so this stays legible at the same zoom.
      .attr('font-size', 22)
      .attr('paint-order', 'stroke')
      .attr('stroke', colors.feetOuterStroke)
      .attr('stroke-width', 4)
      .attr('text-anchor', 'middle')
      .attr('x', d => d.x)
      .attr('y', d => d.y);

    applyLines(entered);

    label.exit().remove();
  }, []);

  // TODO: Maybe it's worth to find a way not to render arrow handles right
  // TODO: under other cards if handle coordinates are calculated that way.
  const renderHandles = useCallback((arrow: ServiceMapArrow) => {
    const handles = helpers.collectHandles(arrow);

    const paths = d3
      .select(handlesGroup.current!)
      .selectAll<SVGPathElement, helpers.ArrowHandle>('path')
      .data(handles, h => helpers.arrowHandleId(h, arrow));

    // NOTE: d3 Update set is handled here
    paths.attr('d', helpers.svg.arrowHandlePath).attr('fill', handleColor(arrow));

    paths
      .enter()
      .append('path')
      .attr('class', 'handle')
      .attr('fill', handleColor(arrow))
      .attr('stroke', 'none')
      .attr('d', helpers.svg.arrowHandlePath);

    paths.exit().remove();
  }, []);

  // NOTE: Unlike renderHandles above, these render regardless of segment
  // NOTE: length -- every line always shows an arrow exiting the sender and
  // NOTE: one entering the receiver.
  const renderEndpointHandles = useCallback((arrow: ServiceMapArrow) => {
    const handles = helpers.collectEndpointHandles(arrow);

    const paths = d3
      .select(endpointHandlesGroup.current!)
      .selectAll<SVGPathElement, helpers.ArrowHandle>('path')
      .data(handles, h => helpers.arrowHandleId(h, arrow));

    paths.attr('d', helpers.svg.arrowHandlePath).attr('fill', handleColor(arrow));

    paths
      .enter()
      .append('path')
      .attr('class', 'handle')
      .attr('fill', handleColor(arrow))
      .attr('stroke', 'none')
      .attr('d', helpers.svg.arrowHandlePath);

    paths.exit().remove();
  }, []);

  useEffect(() => {
    if (!(props.arrow instanceof ServiceMapArrow)) return;

    // NOTE: These three refs are all owned by elements this component
    // NOTE: renders directly, so they're guaranteed attached by the time this
    // NOTE: effect runs -- unlike labelGroup below (Teleported into a
    // NOTE: sibling component's ref), they never need a guard here.
    if (trajectoryGroup.current) renderArrow(props.arrow);
    if (handlesGroup.current) renderHandles(props.arrow);
    if (endpointHandlesGroup.current) renderEndpointHandles(props.arrow);
  }, [props]);

  // NOTE: labelGroup lives inside a <Teleport> to a ref owned by a different
  // NOTE: component (the overlay group) -- on the render where this arrow
  // NOTE: first mounts, that target can still be null for one tick, in which
  // NOTE: case the Teleport renders nothing and labelGroup's ref callback
  // NOTE: never fires. Gating the *entire* arrow (line, handles, everything)
  // NOTE: on this one ref, as a single combined effect used to, meant losing
  // NOTE: that race silently dropped the whole arrow -- not just its label --
  // NOTE: for good, since nothing else about a stable arrow ever changes to
  // NOTE: give the effect a reason to run again. A separate effect here lets
  // NOTE: the label catch up on its own next render without blocking the rest.
  useEffect(() => {
    if (!(props.arrow instanceof ServiceMapArrow)) return;
    if (!labelGroup.current) return;

    renderPortLabel(props.arrow);
  }, [props]);

  const classes = classnames('arrow-body', props.arrow.id);

  const onClick = useCallback(() => {
    props.onArrowClick?.(props.arrow);
  }, [props.onArrowClick, props.arrow]);

  return (
    <g
      className={classes}
      onClick={props.onArrowClick ? onClick : undefined}
      style={props.onArrowClick ? { cursor: 'pointer' } : undefined}
    >
      <g className="trajectory" ref={trajectoryGroup}></g>
      <g className="triangle-handles" ref={handlesGroup}></g>
      <g className="endpoint-handles" ref={endpointHandlesGroup}></g>
      {/* NOTE: Teleported above the cards layer (which paints after this
          component in DOM order) so the label isn't hidden behind one. */}
      <Teleport to={props.overlay}>
        <g className="port-labels" ref={labelGroup}></g>
      </Teleport>
    </g>
  );
});
