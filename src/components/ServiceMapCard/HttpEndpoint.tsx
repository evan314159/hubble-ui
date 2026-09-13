import React from 'react';
import { observer } from 'mobx-react';

import { Method, sortMethods } from '~/domain/http';

import { HTTPEndpointGroup } from './http-groups';
import css from './HttpEndpoint.scss';

export interface Props {
  group: HTTPEndpointGroup;
}

export const HttpEndpoint = observer(function HttpEndpoint(props: Props) {
  const methods = sortMethods(props.group.methods);

  if (methods.size === 0) return null;

  return (
    <div className={css.httpEndpoint}>
      <div className={css.header}>{props.group.url.pathname}</div>

      <div className={css.connectors}>
        {[...methods].map(method => (
          <MethodConnector key={method} method={method} />
        ))}
      </div>
    </div>
  );
});

interface MethodConnectorProps {
  method: Method;
}

const MethodConnector = function MethodConnector(props: MethodConnectorProps) {
  return (
    <div className={css.connector}>
      <div className={css.method}>{props.method}</div>
    </div>
  );
};
