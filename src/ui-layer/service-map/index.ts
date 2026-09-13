import * as mobx from 'mobx';

import { Store } from '~/store';
import { DataLayer } from '~/data-layer';
import { Router } from '~/router';
import { EventEmitter } from '~/utils/emitter';

import { ServiceCard } from '~/domain/service-map';
import { Application } from '~/domain/common';
import { FilterEntry, MatchMode as FilterMatchMode } from '~/domain/filtering/filter-entry';

import { RefsCollector } from '~/ui/service-map/collector';
import { Options } from '~/ui-layer/common';
import { StatusCenter } from '~/ui-layer/status-center';

import {
  ElkServiceMapPlacementStrategy,
  ServiceMapArrowStrategy,
  ServiceMapPlacement,
} from './coordinates';

export enum Event {
  ArrowsDropped = 'arrows-dropped',
}

export type Handlers = {
  [Event.ArrowsDropped]: () => void;
};

export class ServiceMap extends EventEmitter<Handlers> {
  private readonly store: Store;
  private readonly dataLayer: DataLayer;
  private readonly statusCenter: StatusCenter;
  private readonly router: Router;

  public readonly collector: RefsCollector;
  public readonly placement: ServiceMapPlacement;
  public readonly arrows: ServiceMapArrowStrategy;

  @mobx.observable
  public accessor isTimescapeFlowsPageLoading = false;

  @mobx.observable
  public accessor isTimescapeFlowStatsLoading = false;

  @mobx.observable
  public accessor isFullFlowLoading = false;

  @mobx.observable
  public accessor isServiceMapLogsUploading = false;

  constructor(opts: Options) {
    super();

    this.store = opts.store;
    this.dataLayer = opts.dataLayer;
    this.statusCenter = opts.statusCenter;
    this.router = opts.router;

    this.collector = new RefsCollector(this.store.currentFrame);
    this.placement = new ElkServiceMapPlacementStrategy(this.store.currentFrame);
    this.arrows = new ServiceMapArrowStrategy(this.placement);

    this.setupEventHandlers();
  }

  public onArrowsDrop(fn: Handlers[Event.ArrowsDropped]): this {
    this.on(Event.ArrowsDropped, fn);
    return this;
  }

  @mobx.action
  public setFlowStatsLoading(state: boolean) {
    this.isTimescapeFlowStatsLoading = state;
  }

  @mobx.action
  public setFullFlowLoading(state: boolean) {
    this.isFullFlowLoading = state;
  }

  @mobx.action
  public setFlowsPageLoading(state: boolean) {
    this.isTimescapeFlowsPageLoading = state;
  }

  @mobx.action
  public setServiceMapLogsUploading(state: boolean) {
    this.isServiceMapLogsUploading = state;
  }

  public onCardSelect(card: ServiceCard) {
    this.dataLayer.serviceMap.toggleActiveCardFilterEntry(card.filterEntries);
    this.router.commit();
  }

  // NOTE: A specific line only narrows the flow list down to just it under
  // NOTE: AND semantics -- force that mode on regardless of what was active,
  // NOTE: since OR would defeat the point of clicking a specific line.
  // NOTE: Looked up in placement.cardsList (not ServiceStore) since it's a
  // NOTE: superset -- every real card plus whatever world-split/world-merge
  // NOTE: synthetic card currently stands in for a world identity (see
  // NOTE: world-split.ts) -- an arrow's endpoints are always ids from this
  // NOTE: same list, real or synthetic.
  public onArrowSelect(senderId: string, receiverId: string, ports?: number[]) {
    const sender = this.placement.cardsList.find(c => c.id === senderId);
    const receiver = this.placement.cardsList.find(c => c.id === receiverId);
    if (sender == null || receiver == null) return;

    this.dataLayer.controls.setFilterMatchMode(FilterMatchMode.And);
    this.dataLayer.serviceMap.toggleActiveLinkFilterEntry(
      sender.filterEntries,
      receiver.filterEntries,
      ports,
    );
    this.router.commit();
  }

  public onFilterEntriesChange(ff: FilterEntry[] | null) {
    this.dataLayer.controls.setFlowFilters(ff);
    this.router.commit();
  }

  public toggleDetached() {
    console.log(`toggleDetached: dropping layout / collector for service map`);
    this.clearCoordinates();
  }

  public clearCoordinates() {
    this.collector.clear();
    this.placement.reset();
    this.arrows.reset();
  }

  public isCardActive(card: ServiceCard) {
    return this.store.controls.areSomeFilterEntriesEnabled(card.filterEntries);
  }

  public async appToggled(_prev: Application, next: Application) {
    // if (!isChanged) return;

    switch (next) {
      case Application.ServiceMap: {
        // NOTE: This drop is needed to fix incorrect cards sizing after app switch
        mobx.runInAction(() => {
          this.clearCoordinates();
        });

        await this.dataLayer.serviceMap.appOpened();
        break;
      }
    }
  }

  private setupEventHandlers() {
    this.collector.onCoordsUpdated(coords => {
      // NOTE: This runInAction wrapping ensures that no reactions will be
      // triggered in between of those `set` calls.
      this.emit(Event.ArrowsDropped);
      mobx.runInAction(() => {
        // NOTE: We only set card dimensions here, so they are valid even if
        // card was rendered in invisible area with -100500 coords. arrows.arrows
        // is a plain computed over cardsBBoxes/connections/edgeRoutes now, so
        // it picks this up on its own -- no separate rebuild() step needed.
        this.placement.setCardHeights(coords.cards, 0.5);
      });
    });

    this.store.currentFrame.onFlushed(() => {
      this.clearCoordinates();
    });
  }
}
