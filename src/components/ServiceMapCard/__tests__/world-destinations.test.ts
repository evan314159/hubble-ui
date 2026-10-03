import { Flow } from '~/domain/flows';
import { HubbleFlow } from '~/domain/hubble';

import { data } from '~/testing';

import { topWorldDestinations } from '../world-destinations';

const WORLD = 2;

const flowTo = (ip: string, names: string[], expired: string[]): Flow =>
  new Flow({
    ...data.flows.hubbleOne,
    destination: { ...data.flows.hubbleOne.destination!, identity: WORLD },
    ip: { ...data.flows.hubbleOne.ip!, destination: ip },
    destinationNamesList: names,
    destinationNamesExpiredList: expired,
  } as HubbleFlow);

describe('topWorldDestinations: expired DNS names', () => {
  test('an expired name stands in for the IP and is marked', () => {
    const flows = [flowTo('1.1.1.1', [], ['old.example.com'])];

    expect(topWorldDestinations(flows, WORLD, 'egress')).toEqual([
      { key: 'old.example.com', label: 'old.example.com', count: 1, expired: true },
    ]);
  });

  test('the first expired name is used when there are several', () => {
    const flows = [flowTo('1.1.1.1', [], ['a.example.com', 'b.example.com'])];

    expect(topWorldDestinations(flows, WORLD, 'egress')[0].label).toBe('a.example.com');
  });

  test('a current name wins over an expired one and is not marked', () => {
    const flows = [flowTo('1.1.1.1', ['now.example.com'], ['old.example.com'])];

    expect(topWorldDestinations(flows, WORLD, 'egress')).toEqual([
      { key: 'now.example.com', label: 'now.example.com', count: 1, expired: false },
    ]);
  });

  test('an IP with no names is shown as before', () => {
    const flows = [flowTo('1.1.1.1', [], [])];

    expect(topWorldDestinations(flows, WORLD, 'egress')).toEqual([
      { key: '1.1.1.1', label: '1.1.1.1', count: 1, expired: false },
    ]);
  });

  test('a name seen both current and expired is one unmarked row', () => {
    const flows = [
      flowTo('1.1.1.1', ['x.example.com'], []),
      flowTo('1.1.1.1', [], ['x.example.com']),
    ];

    expect(topWorldDestinations(flows, WORLD, 'egress')).toEqual([
      { key: 'x.example.com', label: 'x.example.com', count: 2, expired: false },
    ]);
  });

  test('a name only ever seen expired stays marked across flows', () => {
    const flows = [
      flowTo('1.1.1.1', [], ['x.example.com']),
      flowTo('1.1.1.1', [], ['x.example.com']),
    ];

    expect(topWorldDestinations(flows, WORLD, 'egress')).toEqual([
      { key: 'x.example.com', label: 'x.example.com', count: 2, expired: true },
    ]);
  });

  test('ingress is not broken down', () => {
    expect(
      topWorldDestinations([flowTo('1.1.1.1', [], ['x.example.com'])], WORLD, 'ingress'),
    ).toEqual([]);
  });
});
