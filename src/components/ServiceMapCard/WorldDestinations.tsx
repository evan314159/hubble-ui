import React from 'react';
import { observer } from 'mobx-react';

import * as lang from '~/utils/lang';

import accessPointCss from '~/components/AccessPoint/styles.scss';

import { WorldDestination, MAX_DESTINATIONS, formatWorldDestination } from './world-destinations';
import css from './styles.scss';

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
            <div className={accessPointCss.port}>{formatWorldDestination(d)}</div>
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
