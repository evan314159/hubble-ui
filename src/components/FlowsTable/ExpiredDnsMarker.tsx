import React, { memo } from 'react';
import classnames from 'classnames';
import { Icon } from '@blueprintjs/core';

import css from './styles.scss';

export const EXPIRED_DNS_HINT =
  'DNS record expired. This name comes from a connection that is still open, so it may be out of date.';

export interface ExpiredDnsMarkerProps {
  // Icon size in px. The default suits 12px text; pass a larger size, and a
  // className that aligns it, where the surrounding text is bigger.
  size?: number;
  className?: string;
}

export const ExpiredDnsMarker = memo(function FlowsTableExpiredDnsMarker(
  props: ExpiredDnsMarkerProps,
) {
  // The gap before the icon grows with the icon, so it keeps its proportions.
  const style = props.size != null ? { marginLeft: Math.round(props.size * 0.4) } : undefined;

  return (
    <span
      className={classnames(css.expiredDns, props.className)}
      style={style}
      title={EXPIRED_DNS_HINT}
      aria-label={EXPIRED_DNS_HINT}
      role="img"
    >
      <Icon icon="time" size={props.size ?? 11} />
    </span>
  );
});
