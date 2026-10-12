// Runs the proof-of-grind off the main thread so the page stays smooth.
importScripts('hashprints.js');

let stopped = false;

onmessage = async (e) => {
  if (e.data.type === 'stop') {
    stopped = true;
    return;
  }
  stopped = false;
  const { params } = e.data;
  const t0 = performance.now();
  const result = await HashPrints.grind({
    ...params,
    chunk: 4000,
    onProgress: async (nonce, best) => {
      postMessage({
        type: 'progress',
        nonce,
        best,
        sample: HashPrints.proofHash(params.contract, params.minter, nonce),
        rate: (nonce - (params.startNonce || 0)) / ((performance.now() - t0) / 1000),
      });
      await new Promise((r) => setTimeout(r, 0)); // let a 'stop' message land
      return !stopped;
    },
  });
  postMessage({ type: 'done', result, seconds: (performance.now() - t0) / 1000 });
};
