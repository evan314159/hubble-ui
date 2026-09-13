import { TextEncoder, TextDecoder } from 'util';
global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder;

// NOTE: jsdom doesn't implement ResizeObserver; RefsCollector creates one
// unconditionally, so anything that mounts the service-map UI layer needs it.
global.ResizeObserver =
  global.ResizeObserver ||
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
