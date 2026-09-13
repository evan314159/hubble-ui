import { MutableRefObject as MutRef } from 'react';

import { StoreFrame } from '~/store/frame';
import { reactionRef } from '~/ui/react/refs';
import { EventEmitter } from '~/utils/emitter';

import { XYWH } from '~/domain/geometry';

export enum Event {
  CoordsUpdated = 'coords-updated',
}

export type IdentifierBBox = {
  id: string;
  bbox: XYWH;
};

export type AllCoords = {
  cards: IdentifierBBox[];
};

export type Handlers = {
  [Event.CoordsUpdated]: (coords: AllCoords) => void;
};

// NOTE: This is a helper class that collects refs to important elements
// that are used as connectors
export class RefsCollector extends EventEmitter<Handlers> {
  private cardRoots: Map<string, MutRef<HTMLDivElement | null>> = new Map();
  private elemToCardId: Map<Element, string> = new Map();
  private resizeObserver: ResizeObserver;
  private rootSVGGElement: SVGGElement | null = null;

  // NOTE: A placement-only card (e.g. a split-out world destination) never
  // NOTE: has a matching entry in the store's cardsMap -- that's expected,
  // NOTE: not a bug, so warn about it once per id instead of every single
  // NOTE: measurement pass (which fires continuously while flows stream in).
  private warnedMissingSvcIds: Set<string> = new Set();

  constructor(private frame: StoreFrame) {
    super(false);

    this.resizeObserver = new ResizeObserver(entries => this.onResize(entries));
  }

  public clear() {
    // NOTE: ResizeObserver.disconnect() only stops observing every current
    // NOTE: target -- the observer instance itself stays reusable, so it
    // NOTE: doesn't need recreating here the way the old debounce did.
    this.resizeObserver.disconnect();
    this.elemToCardId.clear();
    this.cardRoots.clear();
    this.rootSVGGElement = null;
    this.warnedMissingSvcIds.clear();
  }

  public onCoordsUpdated(fn: Handlers[Event.CoordsUpdated]): this {
    this.on(Event.CoordsUpdated, fn);
    return this;
  }

  public cardRoot(cardId: string): MutRef<HTMLDivElement | null> {
    const existing = this.cardRoots.get(cardId);
    if (existing != null) return existing;

    // NOTE: React nulls a ref on unmount. Once this ref has actually held a
    // NOTE: mounted element, a later null means the card is genuinely gone
    // NOTE: (not just "not mounted yet") -- drop its entry so it stops being
    // NOTE: tracked forever. Without this, any card that disappears (a split
    // NOTE: world destination aging out of the flow buffer, a pod going
    // NOTE: away, ...) leaks here permanently.
    let wasMounted = false;
    let observedElem: HTMLDivElement | null = null;

    const newRef = reactionRef<HTMLDivElement | null>(null, current => {
      if (observedElem != null) {
        this.resizeObserver.unobserve(observedElem);
        this.elemToCardId.delete(observedElem);
        observedElem = null;
      }

      if (current != null) {
        wasMounted = true;
        observedElem = current;
        this.elemToCardId.set(current, cardId);
        this.ensureRootSVGGElement(current);
        this.resizeObserver.observe(current);
      } else if (wasMounted) {
        this.cardRoots.delete(cardId);
      }
    });

    this.cardRoots.set(cardId, newRef);
    return newRef;
  }

  private onResize(entries: ResizeObserverEntry[]) {
    const g = this.rootSVGGElement;
    if (g == null) {
      console.warn('root svg g element is null: it could happen because of frame flush');
      return;
    }

    // NOTE: Keep this call away from any previous layout transformations as it
    // can cause layout thrashing
    const m = g.getScreenCTM()?.inverse();
    if (m == null) {
      console.warn('cannot get inversed screen matrix, wat?');
      return;
    }

    const cardCoords: IdentifierBBox[] = [];

    entries.forEach(entry => {
      const cardId = this.elemToCardId.get(entry.target);
      if (cardId == null) return;

      const bbox = XYWH.fromDOMRect(entry.target.getBoundingClientRect()).applyDOMMatrix(m);
      cardCoords.push({ id: cardId, bbox });

      if (
        this.frame.services.cardsMap.get(cardId) == null &&
        !this.warnedMissingSvcIds.has(cardId)
      ) {
        this.warnedMissingSvcIds.add(cardId);
        console.warn(`cannot find svc for card ${cardId}`);
      }
    });

    if (cardCoords.length === 0) return;

    this.emit(Event.CoordsUpdated, { cards: cardCoords });
  }

  private ensureRootSVGGElement(elem: HTMLElement): SVGGElement | null {
    if (this.rootSVGGElement != null) return this.rootSVGGElement;

    const g = elem.closest('svg')?.querySelector('g');
    if (g == null) return null;

    this.rootSVGGElement = g;
    return this.rootSVGGElement;
  }
}
