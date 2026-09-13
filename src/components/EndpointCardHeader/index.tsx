import React, { memo } from 'react';

import { ServiceCard } from '~/domain/service-map';

import { EndpointLogo } from './EndpointLogo';

import css from './styles.scss';

export interface Props {
  card: ServiceCard;
  onHeadlineClick?: () => void;
}

export const EndpointCardHeader = memo(function EndpointCardHeader(props: Props) {
  const { card } = props;

  return (
    <div className={css.wrapper}>
      <div className={css.headline} onClick={props.onHeadlineClick}>
        <EndpointLogo card={card} />

        <div className={css.headings}>
          <div className={css.title}>{card.caption}</div>
        </div>
      </div>
    </div>
  );
});
