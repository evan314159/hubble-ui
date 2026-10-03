import React from 'react';

import { WorldDestinations } from '~/components/ServiceMapCard/WorldDestinations';
import { WorldDestination } from '~/components/ServiceMapCard/world-destinations';

import { render } from '~/testing';

const dest = (label: string, expired: boolean): WorldDestination => ({
  key: label,
  label,
  count: 1,
  expired,
});

const markers = (container: HTMLElement) =>
  container.querySelectorAll('[role="img"][aria-label^="DNS record expired"]');

describe('WorldDestinations', () => {
  test('only expired rows get a clock, inside the row text', () => {
    const { container } = render(
      <WorldDestinations destinations={[dest('1.1.1.1', false), dest('old.example.com', true)]} />,
    );

    expect(markers(container).length).toBe(1);

    const clock = markers(container)[0];
    const row = clock.parentElement!;
    expect(row.textContent).toBe('old.example.com');
    expect(clock.className).toContain('worldDestinationClock');
  });

  test('no clocks without expired rows', () => {
    const { container } = render(<WorldDestinations destinations={[dest('1.1.1.1', false)]} />);

    expect(markers(container).length).toBe(0);
  });
});
