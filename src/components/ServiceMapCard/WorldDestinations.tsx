import React from 'react';
import { observer } from 'mobx-react';

import * as lang from '~/utils/lang';

import accessPointCss from '~/components/AccessPoint/styles.scss';
import { ExpiredDnsMarker } from '~/components/FlowsTable/ExpiredDnsMarker';

import { WorldDestination, MAX_DESTINATIONS, formatWorldDestination } from './world-destinations';
import css from './styles.scss';

// The destination text is 24px bold, so the 11px default would be a speck.
const EXPIRED_MARKER_SIZE = 18;

export interface Props {
  destinations: WorldDestination[];
}

export const WorldDestinations = observer(function WorldDestinations(props: Props) {
  if (props.destinations.length === 0) return null;

  const shown = props.destinations.slice(0, MAX_DESTINATIONS);
  const hidden = props.destinations.length - shown.length;
  const hiddenWord = lang.pluralize('destination', hidden);

  return (
    <>
      {shown.map(d => (
        <div key={d.key} className={accessPointCss.accessPoint}>
          <div className={accessPointCss.data}>
            <div className={accessPointCss.port}>
              <span className={css.worldDestination}>
                {formatWorldDestination(d)}
                {d.expired && <ExpiredDnsMarker size={EXPIRED_MARKER_SIZE} />}
              </span>
            </div>
          </div>
        </div>
      ))}

      {hidden > 0 && (
        <div className={css.endpointsLimited}>
          {hiddenWord.num} {hiddenWord.plural} {hiddenWord.be} hidden
        </div>
      )}
    </>
  );
});
