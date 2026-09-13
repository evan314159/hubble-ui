import { Flow } from '~/domain/flows';
import { FilterEntry, Kind as FilterKind, MatchMode, matchesEntries } from './filter-entry';
import { IPProtocol } from '~/domain/hubble';

import { Filters } from '~/domain/filtering';

export const filterFlow = (flow: Flow, filters: Filters): boolean => {
  // NOTE: namespace === '' means "All namespaces" (no restriction) -- only a
  // NOTE: non-empty namespace should actually narrow flows.
  if (!!filters.namespace) {
    if (
      flow.sourceNamespace !== filters.namespace &&
      flow.destinationNamespace !== filters.namespace
    )
      return false;
  }

  if ((filters.verdicts?.size ?? 0) > 0) {
    if (!filters.verdicts?.has(flow.verdict)) return false;
  }

  if (!!filters.skipHost) {
    if (flow.sourceLabelProps.isHost || flow.destinationLabelProps.isHost) {
      return false;
    }
  }

  if (!!filters.skipRemoteNode) {
    const sourceIsRemoteNode = flow.sourceLabelProps.isRemoteNode;
    const destIsRemoteNode = flow.destinationLabelProps.isRemoteNode;

    if (sourceIsRemoteNode || destIsRemoteNode) return false;
  }

  // NOTE: destination port 53 and apporpriate destination label are exactly
  // NOTE: how GetFlowsRequest is built now
  if (!!filters.skipKubeDns) {
    if (
      flow.sourcePort === 53 ||
      (flow.destinationPort === 53 && flow.destinationLabelProps.isKubeDNS)
    )
      return false;
  }

  if (!!filters.skipICMPv6) {
    if (flow.protocol === IPProtocol.ICMPv6) return false;
  }

  if (filters.httpStatus != null) {
    if (flow.httpStatus == null) return false;

    const httpStatus = parseInt(filters.httpStatus);
    const lastChar = filters.httpStatus.slice(-1);
    const rangeSign = ['+', '-'].includes(lastChar) ? lastChar : undefined;

    if (!rangeSign && flow.httpStatus !== httpStatus) return false;
    if (rangeSign === '+' && flow.httpStatus < httpStatus) return false;
    if (rangeSign === '-' && flow.httpStatus > httpStatus) return false;
  }

  if (!filters.filters?.length) return true;

  return matchesEntries(
    filters.filters,
    ff => filterFlowByEntry(flow, ff),
    filters.matchMode ?? MatchMode.Or,
  );
};

export const filterFlowByEntry = (flow: Flow, filter: FilterEntry): boolean => {
  const [key, value] = filter.labelKeyValue;
  let [fromOk, toOk] = [false, false];

  switch (filter.kind) {
    case FilterKind.Label: {
      if (filter.fromRequired) fromOk = flow.senderHasLabelArray([key, value]);
      if (filter.toRequired) toOk = flow.receiverHasLabelArray([key, value]);

      break;
    }
    case FilterKind.Ip: {
      if (filter.fromRequired) fromOk = flow.senderHasIp(filter.query);
      if (filter.toRequired) toOk = flow.receiverHasIp(filter.query);

      break;
    }
    case FilterKind.Dns: {
      if (filter.fromRequired) fromOk = flow.senderHasDomain(filter.query);
      if (filter.toRequired) toOk = flow.receiverHasDomain(filter.query);

      break;
    }
    case FilterKind.Identity: {
      if (filter.fromRequired) fromOk = flow.senderHasIdentity(filter.query);
      if (filter.toRequired) toOk = flow.receiverHasIdentity(filter.query);

      break;
    }
    case FilterKind.TCPFlag: {
      // TODO: Revisit
      return filter.negative !== flow.hasTCPFlag(filter.query.toLowerCase() as any);
    }
    case FilterKind.Pod: {
      if (filter.fromRequired) fromOk = flow.senderPodIs(filter.query);
      if (filter.toRequired) toOk = flow.receiverPodIs(filter.query);

      break;
    }
    case FilterKind.Workload: {
      const workload = filter.asWorkload();
      if (workload == null) break;

      if (filter.fromRequired) fromOk = flow.senderHasWorkload(workload);
      if (filter.toRequired) toOk = flow.receiverHasWorkload(workload);

      break;
    }
    case FilterKind.Port: {
      const port = Number(filter.query);
      if (Number.isNaN(port)) break;

      if (filter.fromRequired) fromOk = flow.sourcePort === port;
      if (filter.toRequired) toOk = flow.destinationPort === port;

      break;
    }
  }

  return filter.negative !== (fromOk || toOk);
};
