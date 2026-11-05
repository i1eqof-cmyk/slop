import { detectCandidates } from './scanner-engine.js';

self.onmessage = (event) => {
  const { tiles, bounds } = event.data;
  try {
    const result = detectCandidates(tiles, bounds);
    self.postMessage({ type: 'complete', result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
