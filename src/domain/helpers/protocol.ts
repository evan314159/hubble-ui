import { IPProtocol } from '~/domain/hubble';

export const toString = (p: IPProtocol): string => {
  return (
    {
      [IPProtocol.TCP]: 'TCP',
      [IPProtocol.UDP]: 'UDP',
      [IPProtocol.ICMPv4]: 'ICMPv4',
      [IPProtocol.ICMPv6]: 'ICMPv6',
      [IPProtocol.Unknown]: 'Unknown protocol',
    }[p] || 'Unknown protocol'
  );
};

// NOTE: ICMP has no port -- the backend reports 0 as a sentinel, not a real
// NOTE: destination port.
export const isPortless = (p: IPProtocol): boolean => {
  return p === IPProtocol.ICMPv4 || p === IPProtocol.ICMPv6;
};

export const formatPortProtocol = (port: number, p: IPProtocol): string => {
  const protocol = toString(p).toLowerCase();
  return isPortless(p) ? protocol : `${port}/${protocol}`;
};
