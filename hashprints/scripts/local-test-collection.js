// Dev helper for the local chain: deploy Test HashPrint, or go live on an existing one.
//   npx hardhat run --network localhost scripts/local-test-collection.js            → deploy
//   ADDRESS=0x… npx hardhat run --network localhost scripts/local-test-collection.js → go live
const { ethers } = require('hardhat');
const HP = require('../site/hashprints');

(async () => {
  if (process.env.ADDRESS) {
    const c = await ethers.getContractAt('HashPrints', process.env.ADDRESS);
    await (await c.openPress()).wait();
    console.log('live', process.env.ADDRESS);
    return;
  }
  const t = HP.COLLECTIONS.test;
  const c = await ethers.deployContract('HashPrints', [t.name, t.symbol, t.priceWei, t.baseURI, t.runSize, t.runs, t.artistProofs, (await ethers.getSigners())[0].address]);
  console.log(await c.getAddress());
})();
