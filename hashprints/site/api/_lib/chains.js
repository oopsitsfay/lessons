// Networks the site reads from, each with several free public nodes. Public nodes come and go and
// each has its own limits (archive reads, log ranges, rate limits, blocked methods), so every
// request falls through the list until one answers. HP_RPC_<chainId> (comma-separated) puts your
// own node first, e.g. an Alchemy or Infura URL; HP_LOCAL_RPC adds a local dev chain for tests.
const { ethers } = require('ethers');

const CHAINS = {
  1: {
    rpcs: ['https://ethereum-rpc.publicnode.com', 'https://rpc.mevblocker.io', 'https://rpc.flashbots.net', 'https://eth.drpc.org', 'https://eth-mainnet.public.blastapi.io', 'https://1rpc.io/eth', 'https://eth-pokt.nodies.app'],
    explorer: 'https://etherscan.io',
    blockscout: 'https://eth.blockscout.com/api/v2',
  },
  11155111: {
    rpcs: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://sepolia.drpc.org', 'https://sepolia.gateway.tenderly.co', 'https://eth-sepolia.public.blastapi.io', 'https://1rpc.io/sepolia'],
    explorer: 'https://sepolia.etherscan.io',
    blockscout: 'https://eth-sepolia.blockscout.com/api/v2',
  },
};
if (process.env.HP_LOCAL_RPC) CHAINS[31337] = { rpcs: [process.env.HP_LOCAL_RPC], explorer: '', blockscout: '' };
for (const id of Object.keys(CHAINS)) {
  const own = (process.env[`HP_RPC_${id}`] || '').split(',').map((s) => s.trim()).filter(Boolean);
  CHAINS[id].rpcs = [...own, ...CHAINS[id].rpcs];
}

// Answers that mean "this node won't do it", not "the call failed": try the next node.
const REFUSED = /archive|personal token|api ?key|rate|limit|exceeded|too large|range|not supported|not whitelisted|not allowed|unavailable|cannot fulfill|timeout|temporarily|capacity|internal error/i;
const resting = new Map(); // url -> time it may be tried again after a transport failure

class FailoverProvider extends ethers.JsonRpcProvider {
  constructor(urls, network) {
    super(urls[0], network, { staticNetwork: network, batchMaxCount: 1 });
    this.urls = urls;
  }

  async _send(payload) {
    const body = JSON.stringify(payload);
    const now = Date.now();
    const order = [...this.urls.filter((u) => (resting.get(u) || 0) <= now), ...this.urls.filter((u) => (resting.get(u) || 0) > now)];
    let last = null;
    for (const url of order) {
      let json;
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
        const text = await r.text();
        try { json = JSON.parse(text); } catch { json = null; }
        if (!r.ok && !json) throw new Error(`HTTP ${r.status}`);
        if (!json) throw new Error('not JSON');
      } catch (e) {
        resting.set(url, Date.now() + 60000);
        last = last || e;
        continue;
      }
      const results = Array.isArray(json) ? json : [json];
      const refused = results.some((x) => x && x.error && (REFUSED.test(x.error.message || '') || [-32005, -32601, 35, -32046, 429].includes(x.error.code)));
      if (refused) { last = results; continue; }
      return results;
    }
    if (Array.isArray(last)) return last; // every node refused: hand back the last answer (e.g. range too large)
    throw last || new Error('no RPC node answered');
  }
}

function provider(chainId) {
  const network = ethers.Network.from(Number(chainId));
  return new FailoverProvider(CHAINS[chainId].rpcs, network);
}

// One node only, for cross-checking answers.
function singleNode(chainId, url) {
  return new FailoverProvider([url], ethers.Network.from(Number(chainId)));
}

module.exports = { CHAINS, provider, singleNode };
