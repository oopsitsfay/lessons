// Mint on a local chain, then resolve the real tokenURI through the metadata API handler.
const { ethers } = require('hardhat');
const HP = require('../site/hashprints');
const meta = require('../site/api/meta/[id].js');
(async () => {
  const [, alice] = await ethers.getSigners();
  const prints = await ethers.deployContract('HashPrints', Object.values((({ name, symbol, priceWei, baseURI, runSize, runs, artistProofs }) => ({ name, symbol, priceWei, baseURI, runSize, runs, artistProofs }))(HP.COLLECTIONS.main)));
  await prints.openPress();
  const proof = await HP.grind({ contract: await prints.getAddress(), minter: alice.address, difficulty: 16 });
  await prints.connect(alice).press(proof.nonce, { value: HP.CONFIG.priceWei });
  const uri = await prints.tokenURI(4);
  console.log('tokenURI', uri);
  const u = new URL(uri);
  const query = { id: u.pathname.split('/').pop(), ...Object.fromEntries(u.searchParams) };
  meta({ query, headers: { host: u.host } }, {
    statusCode: 200, setHeader() {},
    end(b) { const j = JSON.parse(b); console.log(this.statusCode, j.name, '|', j.attributes.map((a) => `${a.trait_type}=${a.value}`).join(', ')); console.log('image', j.image.slice(0, 70) + '…'); },
  });
})();
