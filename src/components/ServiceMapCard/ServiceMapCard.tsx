import React from 'react';
import { observer } from 'mobx-react';
import * as mobx from 'mobx';
import classnames from 'classnames';

import { Tooltip } from '@blueprintjs/core';

import { EndpointCardHeader } from '~/components/EndpointCardHeader';
import { Card, CardProps } from '~/components/Card';
import { Teleport } from '~/components/Teleport';

import { ServiceCard } from '~/domain/service-map';
import { L7Endpoint, ServiceEndpoint } from '~/domain/interactions/endpoints';
import { Connections } from '~/domain/interactions/new-connections';
import { Flow } from '~/domain/flows';

import { EndpointCardLabels } from './EndpointCardLabels';
import { HttpEndpoint } from './HttpEndpoint';
import { HTTPEndpointGroup } from './http-groups';
import { WorldDestinations } from './WorldDestinations';
import { topWorldDestinations } from './world-destinations';

import { RefsCollector } from '~/ui/service-map/collector';
import * as lang from '~/utils/lang';
import css from './styles.scss';

// export type Props = CardComponentProps<ServiceCard>;
export type Props = CardProps<ServiceCard> & {
  collector: RefsCollector;
  l7endpoints?: Connections<L7Endpoint>;
  flows?: Flow[];
  isClusterMeshed?: boolean;
  maxHttpEndpointsVisible?: number;
  active?: boolean;
  showAdditionalInfo?: boolean;
  onGotoProcessTree?: (card: ServiceCard) => void;
};

export const ServiceMapCard = observer(function ServiceMapCard(props: Props) {
  const maxHttpEndpoints = props.maxHttpEndpointsVisible ?? Infinity;

  // NOTE: A world-split per-namespace card (see world-split.ts) inherits the
  // NOTE: real world card's reserved:world-ipv4/6 label -- and so `isWorld`
  // NOTE: and `identity` too -- so it shows the same "top destinations"
  // NOTE: breakdown as the real aggregate world card, just scoped to its own
  // NOTE: namespace and direction (egress/ingress/both) via the values passed
  // NOTE: below (namespace null for the real aggregate card, which has no
  // NOTE: namespace of its own and so shows every destination network-wide).
  const isAggregateWorldCard = props.card.isWorld && props.card.identity > 0;
  // NOTE: A "Group world cards" merge (see world-merge.ts) stashes every
  // NOTE: sibling identity it folded in here -- included so the combined
  // NOTE: card's breakdown covers all of them.
  const identitiesKey = [props.card.identity, ...props.card.mergedWorldIdentities].join(',');
  const direction = props.card.worldCardDirection ?? 'both';

  // NOTE: This used to be a `mobx.computed(() => ...).get()` created fresh on
  // NOTE: every render -- a brand-new computed provides no caching *across*
  // NOTE: renders (only within the one evaluation that immediately follows),
  // NOTE: so every world card re-ran this O(flows buffer) scan on every
  // NOTE: single render, not just when its own inputs actually changed. A
  // NOTE: busy map with many world/split cards turned this into real,
  // NOTE: render-frequency-multiplied cost. useMemo persists across renders,
  // NOTE: keyed on the actual inputs, so it only reruns when one of them does.
  const worldDestinations = React.useMemo(() => {
    if (!isAggregateWorldCard) return [];

    const identities = [props.card.identity, ...props.card.mergedWorldIdentities];
    return topWorldDestinations(props.flows ?? [], identities, direction, props.card.namespace);
  }, [isAggregateWorldCard, props.flows, identitiesKey, direction, props.card.namespace]);

  // NOTE: A card shows only its name -- no port/protocol -- so this only ever
  // NOTE: has something to render when the card is active (selected) and at
  // NOTE: least one of its access points has HTTP endpoint detail to break
  // NOTE: down.
  const accessPoints = mobx
    .computed(() => {
      if (isAggregateWorldCard || !props.active) return [];

      const aps = [...props.card.accessPoints.values()];

      return aps
        .map((ap: ServiceEndpoint) => {
          const groups = HTTPEndpointGroup.createSorted(props.l7endpoints?.get(`${ap.port}`));
          if (groups.length === 0) return null;

          const endpointsWord = lang.pluralize('endpoint', groups.length - maxHttpEndpoints);

          return (
            <React.Fragment key={ap.id}>
              <div className={css.l7groups}>
                {groups.slice(0, maxHttpEndpoints).map(group => {
                  return <HttpEndpoint key={group.key} group={group} />;
                })}
              </div>
              {groups.length > maxHttpEndpoints && (
                <div className={css.endpointsLimited}>
                  {endpointsWord.num} {endpointsWord.plural} {endpointsWord.be} hidden
                </div>
              )}
            </React.Fragment>
          );
        })
        .filter((el): el is React.ReactElement => el != null);
    })
    .get();

  const backplateClasses = classnames({
    [css.serviceMapCardBackplate]: true,
    [css.active]: !!props.active,
  });

  const backgroundClasses = classnames(css.serviceMapCardBackground);
  const foregroundClasses = classnames(css.serviceMapCardForeground);

  return (
    <>
      {/* Render backplate only when card sizes are known */}
      {!props.isUnsizedMode && (
        <>
          <Teleport to={props.underlayRef}>
            <Card coords={props.coords} card={props.card} className={backplateClasses} />
          </Teleport>

          <Teleport to={props.backgroundsRef}>
            <Card coords={props.coords} card={props.card} className={backgroundClasses} />
          </Teleport>
        </>
      )}

      <Card
        {...props}
        isUnsizedMode={!props.isUnsizedMode}
        className={foregroundClasses}
        divRef={props.collector.cardRoot(props.card.id)}
      >
        <EndpointCardHeader
          card={props.card}
          onHeadlineClick={() => props.onHeaderClick?.(props.card)}
        />

        {accessPoints.length > 0 && <div className={css.accessPoints}>{accessPoints}</div>}

        {worldDestinations.length > 0 && (
          <div className={css.accessPoints}>
            <WorldDestinations destinations={worldDestinations} />
          </div>
        )}

        {props.isClusterMeshed && props.card.clusterName && (
          <div className={css.clusterNameLabel}>
            <Tooltip content={`Cluster name: ${props.card.clusterName}`}>
              {props.card.clusterName}
            </Tooltip>
          </div>
        )}

        {props.active && <EndpointCardLabels labels={props.card.labels} />}
      </Card>
    </>
  );
});
