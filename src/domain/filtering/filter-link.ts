import { Link } from '~/domain/service-map';
import { FilterEntry, Kind as FilterKind, MatchMode, matchesEntries } from './filter-entry';
import { IPProtocol } from '~/domain/hubble';

import { Filters } from '~/domain/filtering';

export const filterLink = (link: Link, filters: Filters): boolean => {
  if ((filters.verdicts?.size ?? 0) > 0) {
    let hasVerdict = false;
    for (const verdict of filters.verdicts ?? new Set()) {
      if (link.verdicts.has(verdict)) {
        hasVerdict = true;
        break;
      }
    }
    if (!hasVerdict) return false;
  }

  if (link.isDNSRequest && filters.skipKubeDns) return false;

  if (!!filters.skipICMPv6 && link.ipProtocol === IPProtocol.ICMPv6) return false;

  if (!filters.filters?.length) return true;

  return matchesEntries(
    filters.filters,
    ff => filterLinkByEntry(link, ff),
    filters.matchMode ?? MatchMode.Or,
  );
};

export const filterLinkByEntry = (l: Link, e: FilterEntry): boolean => {
  const sourceIdentityMatch = l.sourceId === e.query;
  const destIdentityMatch = l.destinationId === e.query;

  let [fromOk, toOk] = [false, false];

  switch (e.kind) {
    case FilterKind.Identity: {
      // TODO: This is wrong, coz sourceId/destinationId is not an identity
      if (e.fromRequired) {
        if (!sourceIdentityMatch && e.negative) return true;
        fromOk = sourceIdentityMatch;
      }
      if (e.toRequired) {
        if (!destIdentityMatch && e.negative) return true;
        toOk = destIdentityMatch;
      }

      break;
    }
    case FilterKind.Port: {
      const port = Number(e.query);
      if (Number.isNaN(port)) break;

      const destPortMatch = l.destinationPort === port;

      if (e.fromRequired) {
        if (!destPortMatch && e.negative) return true;
        fromOk = destPortMatch;
      }
      if (e.toRequired) {
        if (!destPortMatch && e.negative) return true;
        toOk = destPortMatch;
      }

      break;
    }
    default: {
      if (e.negative && !sourceIdentityMatch && !destIdentityMatch) return true;
      fromOk = true;
      toOk = true;
    }
  }

  return e.negative || fromOk || toOk;
};
