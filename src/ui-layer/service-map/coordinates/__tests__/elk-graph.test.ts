import {
  buildElkGraph,
  centreOut,
  createElk,
  flattenElkLayout,
  islandConnectedness,
  ElkEdgeInput,
  ElkNodeInput,
} from '../elk-graph';

const pod = (id: string, namespace: string | null): ElkNodeInput => ({
  id,
  w: 120,
  h: 40,
  namespace,
});

const line = (sender: string, receiver: string): ElkEdgeInput => ({ sender, receiver });

describe('islandConnectedness', () => {
  const nodes = [pod('a1', 'a'), pod('a2', 'a'), pod('b1', 'b'), pod('c1', 'c'), pod('w', null)];

  test('counts every line that crosses between two islands, for both ends', () => {
    const edges = [line('a1', 'b1'), line('a2', 'b1'), line('c1', 'a1')];
    const counts = islandConnectedness(nodes, edges);

    expect(counts.get('a')).toBe(3);
    expect(counts.get('b')).toBe(2);
    expect(counts.get('c')).toBe(1);
  });

  test('parallel lines between the same two pods each count', () => {
    const counts = islandConnectedness(nodes, [line('a1', 'b1'), line('a1', 'b1')]);

    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(2);
  });

  test('lines inside one island, or to a top-level card, do not count', () => {
    const counts = islandConnectedness(nodes, [line('a1', 'a2'), line('a1', 'w'), line('w', 'b1')]);

    expect(counts.get('a') ?? 0).toBe(0);
    expect(counts.get('b') ?? 0).toBe(0);
  });
});

describe('centreOut', () => {
  test('puts the first (most connected) item in the middle and fades out to both ends', () => {
    expect(centreOut(['a', 'b', 'c', 'd', 'e'])).toEqual(['e', 'c', 'a', 'b', 'd']);
  });

  test('handles short lists', () => {
    expect(centreOut([])).toEqual([]);
    expect(centreOut(['a'])).toEqual(['a']);
    expect(centreOut(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('buildElkGraph: more connected islands towards the middle', () => {
  // Five sender islands that all feed one receiver island, so ELK puts them in
  // the same row and no ordering of them crosses a line. Island `a` has the
  // most lines and, in plain alphabetical order, would be at the left edge.
  const senders = ['a', 'b', 'c', 'd', 'e'];
  const linesPerSender: Record<string, number> = { a: 5, b: 4, c: 3, d: 2, e: 1 };

  const nodes = [...senders.map(ns => pod(`${ns}-pod`, ns)), pod('r-pod', 'r')];
  const edges = senders.flatMap(ns =>
    Array.from({ length: linesPerSender[ns] }, () => line(`${ns}-pod`, 'r-pod')),
  );

  test('the most connected island is in the middle, fading out to both ends', async () => {
    const result = flattenElkLayout(await createElk().layout(buildElkGraph(nodes, edges)));

    // NOTE: Left-to-right, by island position. The layout direction is UP, so
    // NOTE: ELK may place the input order mirrored; either way the hub is in
    // NOTE: the middle and connectedness rises and then falls.
    const connectedness = islandConnectedness(nodes, edges);
    const lines = senders
      .map(ns => ({ ns, x: result.namespaceBBoxes.get(ns)!.x }))
      .sort((p, q) => p.x - q.x)
      .map(p => connectedness.get(p.ns)!);

    expect(lines.indexOf(Math.max(...lines))).toBe(2);
    expect(lines[0]).toBeLessThan(lines[1]);
    expect(lines[1]).toBeLessThan(lines[2]);
    expect(lines[2]).toBeGreaterThan(lines[3]);
    expect(lines[3]).toBeGreaterThan(lines[4]);
  });
});
