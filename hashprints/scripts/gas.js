const { ethers } = require('hardhat');
const HP = require('../site/hashprints');
(async () => {
  const [owner, alice] = await ethers.getSigners();
  const prints = await ethers.deployContract('HashPrints', [HP.CONFIG.floorWei, '']);
  const deployGas = (await prints.deploymentTransaction().wait()).gasUsed;
  await prints.openPress();
  const proof = await HP.grind({ contract: await prints.getAddress(), minter: alice.address, difficulty: 16 });
  const r = await (await prints.connect(alice).press(proof.nonce, { value: HP.CONFIG.floorWei * 4n })).wait();
  console.log(JSON.stringify({ deployGas: deployGas.toString(), pressGas: r.gasUsed.toString() }));
})();
