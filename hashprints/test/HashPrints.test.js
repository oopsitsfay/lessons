const { expect } = require('chai');
const { ethers } = require('hardhat');
const { setBalance } = require('@nomicfoundation/hardhat-network-helpers');
const HP = require('../site/hashprints');

const PRICE = HP.CONFIG.priceWei;
const ctorArgs = (c, owner) => [c.name, c.symbol, c.priceWei, c.baseURI, c.runSize, c.runs, c.artistProofs, owner];

async function deploy(shape = HP.COLLECTIONS.main) {
  const [owner, alice, bob] = await ethers.getSigners();
  const prints = await ethers.deployContract('HashPrints', ctorArgs(shape, owner.address));
  return { prints, owner, alice, bob, address: await prints.getAddress() };
}

async function grindFor(address, minter, difficulty, opts = {}) {
  return HP.grind({ contract: address, minter, difficulty, ...opts });
}

async function freshWallet() {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await setBalance(w.address, ethers.parseEther('1'));
  return w;
}

describe('HashPrints', function () {
  this.timeout(600000);

  it('deploys with the configured shape and rejects bad configs', async () => {
    const { prints } = await deploy();
    expect(await prints.name()).to.equal('HashPrints');
    expect(await prints.MAX_SUPPLY()).to.equal(3333n);
    expect(await prints.price()).to.equal(PRICE);
    const { prints: test } = await deploy(HP.COLLECTIONS.test);
    expect(await test.name()).to.equal('Test HashPrint');
    expect(await test.symbol()).to.equal('TESTPRINT');
    expect(await test.MAX_SUPPLY()).to.equal(10n);
    const Factory = await ethers.getContractFactory('HashPrints');
    const [deployer] = await ethers.getSigners();
    await expect(ethers.deployContract('HashPrints', ['x', 'x', PRICE, '', 0, 1, 0, deployer.address])).to.be.revertedWithCustomError(Factory, 'BadConfig');
    await expect(ethers.deployContract('HashPrints', ['x', 'x', PRICE, '', 1000, 100, 0, deployer.address])).to.be.revertedWithCustomError(Factory, 'BadConfig');
    await expect(ethers.deployContract('HashPrints', ['x', 'x', PRICE, '', 5, 2, 0, ethers.ZeroAddress])).to.be.revertedWithCustomError(Factory, 'OwnableInvalidOwner');
  });

  it('JS proof hash and zero-bit count match the contract', async () => {
    const { prints, alice, address } = await deploy();
    for (const nonce of [0, 1, 255, 2 ** 32 + 7, 2 ** 40]) {
      const js = HP.proofHash(address, alice.address, nonce);
      expect(await prints.proofHash(alice.address, nonce)).to.equal('0x' + js);
      expect(await prints.leadingZeroBits('0x' + js)).to.equal(BigInt(HP.leadingZeroBits(HP.fromHex(js))));
    }
    expect(await prints.leadingZeroBits(ethers.ZeroHash)).to.equal(256n);
    expect(await prints.leadingZeroBits('0x' + '00'.repeat(2) + '01' + '00'.repeat(29))).to.equal(23n);
  });

  it('refuses to press before the press opens', async () => {
    const { prints, alice, address } = await deploy();
    const proof = await grindFor(address, alice.address, 16);
    await expect(prints.connect(alice).press(proof.nonce, { value: PRICE })).to.be.revertedWithCustomError(prints, 'PressClosed');
  });

  it('presses at exactly the flat price, gas on top, whatever the extra work', async () => {
    const { prints, owner, alice, address } = await deploy();
    await prints.connect(owner).openPress();
    const proof = await grindFor(address, alice.address, 16, { aim: 4 }); // a Golden proof costs the same
    const before = await ethers.provider.getBalance(alice.address);
    const receipt = await (await prints.connect(alice).press(proof.nonce, { value: PRICE })).wait();
    const gas = receipt.gasUsed * receipt.gasPrice;
    expect(before - (await ethers.provider.getBalance(alice.address))).to.equal(PRICE + gas);
    expect(await ethers.provider.getBalance(address)).to.equal(PRICE);
    expect(await prints.ownerOf(4)).to.equal(alice.address); // 1-3 reserved for artist proofs
    expect(await prints.seedOf(4)).to.equal('0x' + proof.hash);
    const ev = receipt.logs.map((l) => prints.interface.parseLog(l)).find((e) => e && e.name === 'Pressed');
    expect(ev.args.extraBits).to.equal(BigInt(proof.extraBits));
    expect(await prints.tokenURI(4)).to.equal(`https://hashprints.vercel.app/api/meta/4?seed=0x${proof.hash}&d=16`);
    expect(await prints.difficultyOf(4)).to.equal(16n);
    await expect(prints.tokenURI(5)).to.be.revertedWithCustomError(prints, 'ERC721NonexistentToken');
  });

  it('rejects any payment other than the exact price', async () => {
    const { prints, owner, alice, address } = await deploy();
    await prints.connect(owner).openPress();
    const proof = await grindFor(address, alice.address, 16);
    for (const value of [0n, PRICE - 1n, PRICE + 1n, PRICE * 4n]) {
      await expect(prints.connect(alice).press(proof.nonce, { value }))
        .to.be.revertedWithCustomError(prints, 'WrongPayment').withArgs(PRICE, value);
    }
  });

  it('rejects weak proofs, stolen proofs and reused proofs', async () => {
    const { prints, owner, alice, bob, address } = await deploy();
    await prints.connect(owner).openPress();
    let weak = 0;
    while (HP.leadingZeroBits(HP.fromHex(HP.proofHash(address, alice.address, weak))) >= 16) weak++;
    await expect(prints.connect(alice).press(weak, { value: PRICE })).to.be.revertedWithCustomError(prints, 'InsufficientWork');
    const proof = await grindFor(address, alice.address, 16, { aim: 2 });
    await expect(prints.connect(bob).press(proof.nonce, { value: PRICE })).to.be.revertedWithCustomError(prints, 'InsufficientWork');
    await prints.connect(alice).press(proof.nonce, { value: PRICE });
    await expect(prints.connect(alice).press(proof.nonce, { value: PRICE })).to.be.revertedWithCustomError(prints, 'ProofAlreadyUsed');
  });

  it('caps public prints at two per wallet', async () => {
    const { prints, owner, alice, bob, address } = await deploy();
    await prints.connect(owner).openPress();
    let nonce = 0;
    for (let i = 0; i < 3; i++) {
      const proof = await grindFor(address, alice.address, 16, { startNonce: nonce });
      nonce = proof.nonce + 1;
      const tx = prints.connect(alice).press(proof.nonce, { value: PRICE });
      if (i < 2) await tx;
      else await expect(tx).to.be.revertedWithCustomError(prints, 'WalletLimitReached');
    }
    expect(await prints.pressedBy(alice.address)).to.equal(2n);
    const proof = await grindFor(address, bob.address, 16);
    await prints.connect(bob).press(proof.nonce, { value: PRICE });
  });

  it('blocks a contract minter from re-entering past the wallet limit', async () => {
    const { prints, owner, address } = await deploy();
    await prints.connect(owner).openPress();
    const attacker = await ethers.deployContract('AttackMinter', [address]);
    const who = await attacker.getAddress();
    const nonces = [];
    let n = 0;
    for (let i = 0; i < 3; i++) {
      const p = await grindFor(address, who, 16, { startNonce: n });
      nonces.push(p.nonce);
      n = p.nonce + 1;
    }
    await expect(attacker.go(nonces, PRICE, { value: PRICE * 3n })).to.be.revertedWithCustomError(prints, 'WalletLimitReached');
    await expect(attacker.go([nonces[0], nonces[0]], PRICE, { value: PRICE * 2n })).to.be.revertedWithCustomError(prints, 'ProofAlreadyUsed');
    expect(await prints.totalSupply()).to.equal(0n);
    await attacker.go(nonces.slice(0, 2), PRICE, { value: PRICE * 2n });
    expect(await prints.balanceOf(who)).to.equal(2n);
    expect(await ethers.provider.getBalance(address)).to.equal(PRICE * 2n);
  });

  it('artist proofs: owner only, capped, free, no duplicate seeds', async () => {
    const { prints, owner, alice, address } = await deploy();
    let nonce = 0;
    for (let i = 1; i <= 3; i++) {
      const proof = await grindFor(address, owner.address, 16, { startNonce: nonce });
      nonce = proof.nonce + 1;
      await prints.connect(owner).pressArtistProof(proof.nonce);
      expect(await prints.ownerOf(i)).to.equal(owner.address);
      expect(await prints.difficultyOf(i)).to.equal(16n);
      if (i === 2) await expect(prints.connect(owner).pressArtistProof(proof.nonce)).to.be.revertedWithCustomError(prints, 'ProofAlreadyUsed');
    }
    const extra = await grindFor(address, owner.address, 16, { startNonce: nonce });
    await expect(prints.connect(owner).pressArtistProof(extra.nonce)).to.be.revertedWithCustomError(prints, 'SoldOut');
    const aliceProof = await grindFor(address, alice.address, 16);
    await expect(prints.connect(alice).pressArtistProof(aliceProof.nonce)).to.be.revertedWithCustomError(prints, 'OwnableUnauthorizedAccount');
    // The test shape has no artist proofs at all.
    const { prints: test, address: testAddr } = await deploy(HP.COLLECTIONS.test);
    const p = await grindFor(testAddr, owner.address, 16);
    await expect(test.connect(owner).pressArtistProof(p.nonce)).to.be.revertedWithCustomError(test, 'SoldOut');
  });

  it('Test HashPrint sells out all 10, steps runs, and then refuses', async () => {
    const { prints, owner, address } = await deploy(HP.COLLECTIONS.test);
    await prints.connect(owner).openPress();
    let wallet, nonce = 0;
    for (let i = 1; i <= 10; i++) {
      if (!wallet || (await prints.pressedBy(wallet.address)) === 2n) { wallet = await freshWallet(); nonce = 0; }
      const proof = await grindFor(address, wallet.address, Number(await prints.difficulty()), { startNonce: nonce });
      nonce = proof.nonce + 1;
      const tx = prints.connect(wallet).press(proof.nonce, { value: PRICE });
      if (i === 5) await expect(tx).to.emit(prints, 'RunStarted');
      else await tx;
      expect(await prints.ownerOf(i)).to.equal(wallet.address); // no artist proofs: ids start at 1
    }
    expect(await prints.totalSupply()).to.equal(10n);
    expect(await prints.currentRun()).to.equal(2n);
    expect(await ethers.provider.getBalance(address)).to.equal(PRICE * 10n);
    expect(await prints.tokenURI(10)).to.match(/^https:\/\/hashprints\.vercel\.app\/api\/test\/meta\/10\?seed=0x0000/);
    const late = await freshWallet();
    const proof = await grindFor(address, late.address, 16);
    await expect(prints.connect(late).press(proof.nonce, { value: PRICE })).to.be.revertedWithCustomError(prints, 'SoldOut');
  });

  it('difficulty rises one bit every two runs and is recorded per token', async () => {
    const shape = { ...HP.COLLECTIONS.test, runSize: 1, runs: 5 };
    const { prints, owner, address } = await deploy(shape);
    await prints.connect(owner).openPress();
    const seen = [];
    for (let i = 0; i < 5; i++) {
      seen.push(Number(await prints.difficulty()));
      const w = await freshWallet();
      const proof = await grindFor(address, w.address, seen[i]);
      await prints.connect(w).press(proof.nonce, { value: PRICE });
      expect(await prints.difficultyOf(i + 1)).to.equal(BigInt(seen[i]));
    }
    expect(seen).to.deep.equal([16, 16, 17, 17, 18]);
    expect(seen.map((_, r) => HP.difficultyForRun(r))).to.deep.equal(seen);
  });

  it('base URI can be locked for good', async () => {
    const { prints, owner, alice } = await deploy();
    await expect(prints.connect(alice).lockBaseURI()).to.be.revertedWithCustomError(prints, 'OwnableUnauthorizedAccount');
    await prints.connect(owner).setBaseURI('https://hashprints.vercel.app/api/meta/');
    await expect(prints.connect(owner).lockBaseURI()).to.emit(prints, 'BaseURILocked').withArgs('https://hashprints.vercel.app/api/meta/');
    expect(await prints.baseURILocked()).to.equal(true);
    await expect(prints.connect(owner).setBaseURI('https://evil.example/')).to.be.revertedWithCustomError(prints, 'BaseURIIsLocked');
  });

  it('deploys through the public CREATE2 deployer with the named owner', async () => {
    // Arachnid's deterministic deployment proxy; runtime code read from mainnet (eth_getCode).
    const PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
    await ethers.provider.send('hardhat_setCode', [PROXY, '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3']);
    const [, alice] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('HashPrints');
    const { data: initcode } = await Factory.getDeployTransaction(...ctorArgs(HP.COLLECTIONS.test, alice.address));
    const salt = ethers.id('hashprints-test');
    const predicted = ethers.getCreate2Address(PROXY, salt, ethers.keccak256(initcode));
    await (await alice.sendTransaction({ to: PROXY, data: ethers.concat([salt, initcode]) })).wait();
    const prints = await ethers.getContractAt('HashPrints', predicted);
    expect(await prints.owner()).to.equal(alice.address);
    expect(await prints.name()).to.equal('Test HashPrint');
    expect(await prints.MAX_SUPPLY()).to.equal(10n);
  });

  it('ownership transfers in two steps', async () => {
    const { prints, owner, alice } = await deploy();
    await prints.connect(owner).transferOwnership(alice.address);
    expect(await prints.owner()).to.equal(owner.address);
    expect(await prints.pendingOwner()).to.equal(alice.address);
    await prints.connect(alice).acceptOwnership();
    expect(await prints.owner()).to.equal(alice.address);
  });

  it('owner controls: price locked once open, withdraw', async () => {
    const { prints, owner, alice, address } = await deploy();
    await expect(prints.connect(alice).setPrice(1n)).to.be.revertedWithCustomError(prints, 'OwnableUnauthorizedAccount');
    await expect(prints.connect(owner).setPrice(PRICE * 2n)).to.emit(prints, 'PriceSet').withArgs(PRICE * 2n);
    await prints.connect(owner).setPrice(PRICE);
    await expect(prints.connect(owner).openPress()).to.emit(prints, 'PressOpened');
    await expect(prints.connect(owner).setPrice(1n)).to.be.revertedWithCustomError(prints, 'PressAlreadyOpen');
    await expect(prints.connect(owner).openPress()).to.be.revertedWithCustomError(prints, 'PressAlreadyOpen');

    const proof = await grindFor(address, alice.address, 16);
    await prints.connect(alice).press(proof.nonce, { value: PRICE });
    await expect(prints.connect(alice).withdraw(alice.address)).to.be.revertedWithCustomError(prints, 'OwnableUnauthorizedAccount');
    await expect(prints.connect(owner).withdraw(ethers.ZeroAddress)).to.be.revertedWithCustomError(prints, 'ZeroAddress');
    await expect(prints.connect(owner).withdraw(owner.address)).to.changeEtherBalance(owner, PRICE);
  });
});
