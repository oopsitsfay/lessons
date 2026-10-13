// Networks the site reads from. HP_LOCAL_RPC adds a local dev chain for tests.
const CHAINS = {
  1: { rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io', blockscout: 'https://eth.blockscout.com/api/v2' },
  11155111: { rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io', blockscout: 'https://eth-sepolia.blockscout.com/api/v2' },
};
if (process.env.HP_LOCAL_RPC) CHAINS[31337] = { rpc: process.env.HP_LOCAL_RPC, explorer: '', blockscout: '' };

function provider(chainId) {
  const { ethers } = require('ethers');
  const network = ethers.Network.from(Number(chainId));
  return new ethers.JsonRpcProvider(CHAINS[chainId].rpc, network, { staticNetwork: network, batchMaxCount: 50 });
}

module.exports = { CHAINS, provider };
