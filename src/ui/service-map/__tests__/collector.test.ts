import { RefsCollector, Event, AllCoords } from '../collector';

// NOTE: jsdom has neither layout nor DOMPoint, so this stands in for the little
// NOTE: of both that the collector uses.
class FakeDOMPoint {
  constructor(
    public x: number,
    public y: number,
  ) {}

  matrixTransform(m: { a: number; d: number; e: number; f: number }) {
    return { x: m.a * this.x + m.e, y: m.d * this.y + m.f };
  }
}

type ResizeCallback = (entries: unknown[]) => void;

describe('RefsCollector: card size', () => {
  const realResizeObserver = global.ResizeObserver;
  const realDOMPoint = (global as any).DOMPoint;
  let resizeCallback: ResizeCallback;

  beforeEach(() => {
    (global as any).DOMPoint = FakeDOMPoint;
    global.ResizeObserver = class {
      constructor(cb: ResizeCallback) {
        resizeCallback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    global.ResizeObserver = realResizeObserver;
    (global as any).DOMPoint = realDOMPoint;
  });

  // A card whose content is `layoutH` tall in the map's own units, inside a
  // root <g> that scales the map by `scale`. `reportedRectH` is what the
  // browser's getBoundingClientRect() says its height is.
  const measure = (opts: {
    layoutH: number;
    scale: number;
    reportedRectH: number;
    borderBoxSize?: boolean;
  }): AllCoords['cards'][number] => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const card = document.createElement('div');
    svg.appendChild(g);
    g.appendChild(card);

    (g as any).getScreenCTM = () => ({
      inverse: () => ({ a: 1 / opts.scale, d: 1 / opts.scale, e: 0, f: 0 }),
    });
    Object.defineProperty(card, 'offsetWidth', { value: 560 });
    Object.defineProperty(card, 'offsetHeight', { value: opts.layoutH });
    card.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 560 * opts.scale, height: opts.reportedRectH }) as DOMRect;

    const frame = { services: { cardsMap: new Map([['card-1', {}]]) } } as any;
    const collector = new RefsCollector(frame);

    let coords: AllCoords | null = null;
    collector.onCoordsUpdated(c => {
      coords = c;
    });

    collector.cardRoot('card-1').current = card;

    resizeCallback([
      {
        target: card,
        borderBoxSize: opts.borderBoxSize
          ? [{ inlineSize: 560, blockSize: opts.layoutH }]
          : undefined,
      },
    ]);

    expect(coords).not.toBeNull();
    return coords!.cards[0];
  };

  test('Chrome: the rectangle is the on-screen size, the height is the layout height', () => {
    const card = measure({ layoutH: 120, scale: 0.732, reportedRectH: 120 * 0.732 });

    expect(card.bbox.h).toBeCloseTo(120, 5);
  });

  test('Safari: a rectangle that is not the on-screen size does not shrink the card', () => {
    // The numbers seen in Safari for the operator card.
    const card = measure({ layoutH: 120, scale: 0.7320241664671308, reportedRectH: 56.9976654 });

    expect(card.bbox.h).toBe(120);
  });

  test('uses the observer entry border box when the browser provides one', () => {
    const card = measure({ layoutH: 120.5, scale: 0.5, reportedRectH: 30, borderBoxSize: true });

    expect(card.bbox.h).toBe(120.5);
  });

  test(`reports the event for the right card`, () => {
    expect(Event.CoordsUpdated).toBe('coords-updated');
    expect(measure({ layoutH: 90, scale: 1, reportedRectH: 90 }).id).toBe('card-1');
  });
});
