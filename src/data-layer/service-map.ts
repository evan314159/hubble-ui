import { BackendAPI, ServiceMapStream } from '~/api/customprotocol';
import { EventParams } from '~/api/general/event-stream';

import { Flow } from '~/domain/flows';
import {
  FilterEntry,
  FilterDirection,
  FiltersDiff,
  filterFlow,
  filterLink,
} from '~/domain/filtering';
import { DataMode, TransferState } from '~/domain/interactions';
import { StreamKind } from '~/domain/interactions/reconnect-state';
import { ServiceChange, ServiceLinkChange } from '~/domain/events';
import { Link } from '~/domain/link';

import { ConnectEvent } from './connect-event';
import { Options } from './common';

import { Store, StoreFrame } from '~/store';
import { Retries } from '~/utils/retry';
import { EventEmitter } from '~/utils/emitter';

export enum Event {
  FlowsDiff = 'flows-diff-count',
  FlowFiltersShouldBeChanged = 'filter-entries-should-be-changed',
  ConnectEvent = 'connect-event',
}

export type Handlers = {
  [Event.FlowsDiff]: (dc: number, f: StoreFrame) => void;
  [Event.FlowFiltersShouldBeChanged]: (fe: FilterEntry[]) => void;
  [Event.ConnectEvent]: (rs: ConnectEvent) => void;
};

export class ServiceMap extends EventEmitter<Handlers> {
  private backendAPI: BackendAPI;
  private store: Store;
  private transferState: TransferState;

  private streamFlags?: Partial<EventParams>;
  private stream: ServiceMapStream | null = null;
  private streamRetries: Retries = Retries.newExponential();

  constructor(opts: Options) {
    super(true);

    this.store = opts.store;
    this.backendAPI = opts.backendAPI;
    this.transferState = opts.transferState;
  }

  public get isAppActive(): boolean {
    return this.stream != null;
  }

  public onFlowsDiffCount(fn: Handlers[Event.FlowsDiff]): this {
    this.on(Event.FlowsDiff, fn);
    return this;
  }

  public onFlowFiltersShouldBeChanged(fn: Handlers[Event.FlowFiltersShouldBeChanged]): this {
    this.on(Event.FlowFiltersShouldBeChanged, fn);
    return this;
  }

  public onConnectEvent(fn: Handlers[Event.ConnectEvent]): this {
    this.on(Event.ConnectEvent, fn);
    return this;
  }

  public async switchToDataMode(dm: DataMode) {
    await this.resetDataFetch(dm);
  }

  public async resetDataFetch(dm?: DataMode) {
    const dataMode = dm || this.transferState.dataMode;

    await this.dropDataFetch();
    await this.ensureDataFetch(dataMode);
  }

  public async ensureDataFetch(forDataMode?: DataMode) {
    const dm = forDataMode || this.transferState.dataMode;
    console.log(`service map: ensuring data fetch for mode: ${dm}`);

    if (dm === DataMode.CiliumStreaming) {
      this.ensureLiveStream();
    }
  }

  public async appOpened() {
    const dataMode = this.transferState.isDisabled
      ? this.pickDataModeForNamespace()
      : this.transferState.dataMode;

    await this.ensureDataFetch(dataMode);
  }

  public async dropDataFetch() {
    if (this.stream != null) {
      this.stream.offAllEvents();
      await this.stream.stop();

      this.stream = null;
    }

    this.transferState.dropReconnectState(StreamKind.Event);
    this.streamRetries.reset();
  }

  public ensureLiveStream(): ServiceMapStream {
    console.log('ensuring service map data stream');
    if (this.stream != null) return this.stream;

    this.stream = this.backendAPI
      .serviceMapStream(this.store.filters, this.streamFlags)
      .onServices(svcs => {
        this.store.currentFrame.applyServiceChanges(this.filterServiceChanges(svcs));
      })
      .onServiceLinks(links => {
        this.store.currentFrame.applyServiceLinkChanges(this.filterServiceLinkChanges(links));
      })
      .onFlows(flows => this.handleFlows(this.store.currentFrame, flows))
      .onReconnectAttemptFailed((att, err) => this.handleReconnectFail(att, err))
      .onReconnectAttempt((att, d) => this.handleReconnectDelay(att, d))
      .onReconnected(attempt => this.handleReconnected(attempt))
      .onTerminated(isStopped => this.handleTerminated(isStopped))
      .run();

    return this.stream;
  }

  public handleReconnectFail(attempt: number, err: any) {
    this.transferState.updateReconnectState(StreamKind.Event, old => ({
      ...old,
      attempt,
      lastError: err,
    }));

    this.emit(Event.ConnectEvent, ConnectEvent.newFailed().setAttempt(attempt).setError(err));
  }

  public handleReconnectDelay(attempt: number, delay: number) {
    this.transferState.updateReconnectState(StreamKind.Event, old => ({
      ...old,
      attempt,
      delay,
    }));

    this.emit(
      Event.ConnectEvent,
      ConnectEvent.newAttemptDelay().setAttempt(attempt).setDelay(delay),
    );
  }

  public handleReconnected(att: number) {
    if (att === 1) return;

    const states = this.transferState.reconnectStates;
    const isAllReconnected = states.size === 1 && states.has(StreamKind.Event);

    this.transferState.dropReconnectState(StreamKind.Event);
    this.streamRetries.reset();

    this.emit(
      Event.ConnectEvent,
      ConnectEvent.newSuccess().setAttempt(att).setAllReconnected(isAllReconnected),
    );
  }

  public async handleTerminated(isStopped: boolean) {
    // NOTE: isStopped set to true can be only in case when entire stream was
    // forced to stop, for example when filters are changed..
    if (isStopped) {
      this.transferState.dropReconnectState(StreamKind.Event);
      this.streamRetries.reset();
      return;
    }

    if (this.stream == null) {
      console.error('unreachable: stream just terminated, but it is null');
      return;
    }

    // NOTE: When isStopped set to false, it means that stream was terminated
    // by backend and we probably need to try to recreate it...
    this.emit(Event.ConnectEvent, ConnectEvent.newDisconnected());

    // NOTE: Stream was terminated, so we don't need to call .stop() on it
    this.stream.terminate().offAllEvents();
    this.stream = null;

    // NOTE: Recreate stream with exact last params used (including possible
    // policies enabled)
    const nextDelay = this.streamRetries.nextDelay();
    const state = this.transferState.updateReconnectState(StreamKind.Event, old => ({
      ...old,
      attempt: (old?.attempt || 0) + 1,
      delay: nextDelay,
    }));

    this.emit(
      Event.ConnectEvent,
      ConnectEvent.newAttemptDelay().setAttempt(state.attempt).setDelay(nextDelay),
    );

    await this.streamRetries.wait();
    if (this.transferState.reconnectStates.get(StreamKind.Event) == null) {
      // NOTE: We are here if `dropDataFetch` was called during the wait
      this.streamRetries.reset();
      return;
    }

    this.ensureLiveStream();
  }

  public async enablePoliciesFetch() {
    this.streamFlags = Object.assign({}, this.streamFlags, { policies: true });

    if (this.stream != null) {
      // NOTE: Means that we already have stream setup and thus we are not
      // in timescape only mode
      await this.stream.updateEventFlags(this.streamFlags);
    } else {
      await this.ensureDataFetch();
    }
  }

  public async filtersChanged(f: FiltersDiff) {
    // NOTE: The idea is to react on filters change if only app is active
    // in the background/foreground.
    if (!this.isAppActive) return;

    // NOTE: Stream is supposed to be null if ServiceMap wasn't ever opened
    await this.dropDataFetch();

    if (f.podFiltersChanged || f.namespace.changed) {
      this.store.flush({ globalFrame: true });
    }

    // NOTE: This call will take from global frame only that data that matches
    // current set of filters
    console.log(`right before resetCurrentFrame`);
    this.store.resetCurrentFrame(this.store.filters, { preserveActiveCards: true });

    await this.ensureDataFetch();
  }

  // NOTE: Takes the card's filterEntries directly rather than a cardId to
  // NOTE: look up in ServiceStore -- a world-split synthetic card (see
  // NOTE: world-split.ts) is never registered there, only in the placement's
  // NOTE: own cardsList, so the caller (which has the actual ServiceCard
  // NOTE: object already) resolves this instead.
  public toggleActiveCardFilterEntry(filterEntries: FilterEntry[]) {
    if (filterEntries.length === 0) return;

    const isActive = this.store.controls.areSomeFilterEntriesEnabled(filterEntries);
    const [include, exclude] = !isActive ? [filterEntries, []] : [[], filterEntries];

    const [flowFilters, isChanged] = FilterEntry.combine(
      this.store.controls.flowFilters,
      include,
      exclude,
    );

    if (!isChanged) return;
    this.emit(Event.FlowFiltersShouldBeChanged, flowFilters);
  }

  // NOTE: Unlike a card (any one of its filterEntries matching is enough --
  // NOTE: they're alternative ways to identify the same service), a link is
  // NOTE: the conjunction of "from this sender" AND "to this receiver" AND
  // NOTE: "on this port" -- combine() only ever merges into whatever filters
  // NOTE: were already active, so mixing a line's entries with unrelated
  // NOTE: earlier ones would (correctly, under AND) almost always match
  // NOTE: nothing. Replace the filter set outright instead.
  // NOTE: Takes each endpoint's filterEntries directly rather than an id to
  // NOTE: look up -- see toggleActiveCardFilterEntry above for why.
  public toggleActiveLinkFilterEntry(
    senderEntries: FilterEntry[],
    receiverEntries: FilterEntry[],
    ports?: number[],
  ) {
    // NOTE: A card's filterEntries can include aliases (label/workload/dns)
    // NOTE: alongside identity -- fine for card-click OR-of-aliases, but
    // NOTE: Link can't evaluate those kinds and treats them as an automatic
    // NOTE: match, which would let a redundant alias entry silently satisfy
    // NOTE: the AND group an identity check was supposed to gate. Identity
    // NOTE: alone is enough to pin down an endpoint, so prefer it exclusively
    // NOTE: when available.
    const endpointEntries = (entries: FilterEntry[]) => {
      const identityOnly = entries.filter(fe => fe.isIdentity);
      return identityOnly.length > 0 ? identityOnly : entries;
    };

    const linkEntries = [
      ...endpointEntries(senderEntries).map(fe => fe.setDirection(FilterDirection.From)),
      ...endpointEntries(receiverEntries).map(fe => fe.setDirection(FilterDirection.To)),
      ...(ports ?? []).map(port => FilterEntry.newPort(port).setDirection(FilterDirection.To)),
    ];

    if (linkEntries.length === 0) return;

    const isShowingExactlyThisLink = FiltersDiff.filterEntriesEqual(
      this.store.controls.flowFilters,
      linkEntries,
    );

    this.emit(Event.FlowFiltersShouldBeChanged, isShowingExactlyThisLink ? [] : linkEntries);
  }

  private pickDataModeForNamespace(): DataMode {
    return DataMode.CiliumStreaming;
  }

  // NOTE: The backend query doesn't understand matchMode or port filtering
  // NOTE: (frontend-only concepts), so it can stream flows/links the active
  // NOTE: filters would actually reject -- re-check each one client-side
  // NOTE: before it lands in the displayed frame.
  private handleFlows(frame: StoreFrame, flows: Flow[]) {
    const filtered = flows.filter(f => filterFlow(f, this.store.filters));
    const { flowsDiffCount } = frame.addFlows(filtered);

    this.emit(Event.FlowsDiff, flowsDiffCount, frame);
  }

  private filterServiceLinkChanges(changes: ServiceLinkChange[]): ServiceLinkChange[] {
    const filters = this.store.filters;

    return changes.filter(change => filterLink(Link.fromHubbleLink(change.serviceLink), filters));
  }

  // NOTE: filterLink/filterFlow narrow which links/flows show, but a card
  // NOTE: unrelated to any of them still arrives via its own onServices event
  // NOTE: and would otherwise sit in the graph disconnected. Identity is the
  // NOTE: one thing every endpoint entry click-to-filter builds (see
  // NOTE: toggleActiveLinkFilterEntry) reliably carries, so use it to decide
  // NOTE: which cards belong. When no identity entry is active, there's
  // NOTE: nothing reliable to narrow by, so leave services untouched.
  private filterServiceChanges(changes: ServiceChange[]): ServiceChange[] {
    const filters = this.store.filters;
    if (!filters.filters?.length) return changes;

    const identities = filters.filters.filter(fe => fe.isIdentity).map(fe => fe.query);
    if (identities.length === 0) return changes;

    const allowed = new Set(identities);
    return changes.filter(change => allowed.has(change.service.identity.toString()));
  }
}
