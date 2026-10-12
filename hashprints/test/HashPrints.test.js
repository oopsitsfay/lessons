const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time, setBalance } = require('@nomicfoundation/hardhat-network-helpers');
const HP = require('../site/hashprints');

const FLOOR = HP.CONFIG.floorWei;

async function deploy() {
  const [owner, alice, bob] = await ethers.getSigners();
  const prints = await ethers.deployContract('HashPrints', [FLOOR, 'https://hashprints.example/meta/']);
  return { prints, owner, alice, bob, address: await prints.getAddress() };
}

async function grindFor(address, minter, difficulty, opts = {}) {
  return HP.grind({ contract: address, minter, difficulty, ...opts });
}

describe('HashPrints', function () {
  this.timeout(600000);

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
    await expect(prints.connect(alice).press(proof.nonce, { value: FLOOR * 4n }))
      .to.be.revertedWithCustomError(prints, 'PressClosed');
  });

  it('presses a print with a valid grind, stores the seed, and refunds overpayment', async () => {
    const { prints, owner, alice, address } = await deploy();
    await prints.connect(owner).openPress();
    const proof = await grindFor(address, alice.address, 16);
    const before = await ethers.provider.getBalance(alice.address);
    const tx = await prints.connect(alice).press(proof.nonce, { value: ethers.parseEther('1') });
    const receipt = await tx.wait();
    const gas = receipt.gasUsed * receipt.gasPrice;
    const event = receipt.logs.map((l) => prints.interface.parseLog(l)).find((e) => e && e.name === 'Pressed');
    const paid = event.args.price;

    expect(await prints.ownerOf(4)).to.equal(alice.address); // 1-3 reserved for artist proofs
    expect(await prints.seedOf(4)).to.equal('0x' + proof.hash);
    expect(event.args.extraBits).to.equal(BigInt(proof.extraBits));
    expect(before - (await ethers.provider.getBalance(alice.address))).to.equal(paid + gas);
    expect(await ethers.provider.getBalance(address)).to.equal(paid);
    expect(await prints.tokenURI(4)).to.equal(`https://hashprints.example/meta/4?seed=0x${proof.hash}&d=16`);
    expect(await prints.difficultyOf(4)).to.equal(16n);
    await expect(prints.tokenURI(5)).to.be.revertedWithCustomError(prints, 'ERC721NonexistentToken');
  });

  it('rejects weak proofs, stolen proofs, reused proofs and underpayment', async () => {
    const { prints, owner, alice, bob, address } = await deploy();
    await prints.connect(owner).openPress();

    // A nonce with too few zero bits.
    let weak = 0;
    while (HP.leadingZeroBits(HP.fromHex(HP.proofHash(address, alice.address, weak))) >= 16) weak++;
    await expect(prints.connect(alice).press(weak, { value: FLOOR * 4n }))
      .to.be.revertedWithCustomError(prints, 'InsufficientWork');

    // Proofs are bound to the minter: Bob can't use Alice's nonce.
    const proof = await grindFor(address, alice.address, 16, { aim: 2 });
    await expect(prints.connect(bob).press(proof.nonce, { value: FLOOR * 4n }))
      .to.be.revertedWithCustomError(prints, 'InsufficientWork');

    await expect(prints.connect(alice).press(proof.nonce, { value: FLOOR }))
      .to.be.revertedWithCustomError(prints, 'Underpaid');

    await prints.connect(alice).press(proof.nonce, { value: FLOOR * 4n });
    await expect(prints.connect(alice).press(proof.nonce, { value: FLOOR * 4n }))
      .to.be.revertedWithCustomError(prints, 'ProofAlreadyUsed');
  });

  it('caps public prints at two per wallet', async () => {
    const { prints, owner, alice, bob, address } = await deploy();
    await prints.connect(owner).openPress();
    let nonce = 0;
    for (let i = 0; i < 3; i++) {
      const proof = await grindFor(address, alice.address, 16, { startNonce: nonce });
      nonce = proof.nonce + 1;
      const tx = prints.connect(alice).press(proof.nonce, { value: FLOOR * 4n });
      if (i < 2) await tx;
      else await expect(tx).to.be.revertedWithCustomError(prints, 'WalletLimitReached');
    }
    expect(await prints.pressedBy(alice.address)).to.equal(2n);
    expect(await prints.balanceOf(alice.address)).to.equal(2n);
    // Other wallets are unaffected.
    const proof = await grindFor(address, bob.address, 16);
    await prints.connect(bob).press(proof.nonce, { value: FLOOR * 4n });
  });

  it('Dutch price cools to the floor and extra bits halve the premium, matching the JS model', async () => {
    const { prints, owner } = await deploy();
    await prints.connect(owner).openPress();
    const opened = await prints.runStartedAt();
    for (const elapsed of [1, 60, 990, 1979, 1980, 5000]) {
      await time.setNextBlockTimestamp(opened + BigInt(elapsed));
      await ethers.provider.send('evm_mine', []);
      for (const extra of [0, 1, 3, 8, 300]) {
        expect(await prints.priceFor(extra)).to.equal(HP.priceFor(elapsed, extra), `t=${elapsed} extra=${extra}`);
      }
    }
    expect(await prints.currentPrice()).to.equal(FLOOR);
  });

  it('artist proofs: owner only, max three, ids 1-3, free', async () => {
    const { prints, owner, alice, address } = await deploy();
    let nonce = 0;
    for (let i = 1; i <= 3; i++) {
      const proof = await grindFor(address, owner.address, 16, { startNonce: nonce });
      nonce = proof.nonce + 1;
      await prints.connect(owner).pressArtistProof(proof.nonce);
      expect(await prints.ownerOf(i)).to.equal(owner.address);
      expect(await prints.difficultyOf(i)).to.equal(16n);
      if (i === 2) {
        await expect(prints.connect(owner).pressArtistProof(proof.nonce)).to.be.revertedWithCustomError(prints, 'ProofAlreadyUsed');
      }
    }
    const extra = await grindFor(address, owner.address, 16, { startNonce: nonce });
    await expect(prints.connect(owner).pressArtistProof(extra.nonce)).to.be.revertedWithCustomError(prints, 'SoldOut');
    const aliceProof = await grindFor(address, alice.address, 16);
    await expect(prints.connect(alice).pressArtistProof(aliceProof.nonce))
      .to.be.revertedWithCustomError(prints, 'OwnableUnauthorizedAccount');
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
    const per = FLOOR * 4n;
    // Re-entering for a third print reverts the whole transaction.
    await expect(attacker.go(nonces, per, false, { value: per * 3n })).to.be.revertedWithCustomError(prints, 'WalletLimitReached');
    expect(await prints.totalSupply()).to.equal(0n);
    // Re-entering with the same proof is caught too.
    await expect(attacker.go([nonces[0], nonces[0]], per, false, { value: per * 2n })).to.be.revertedWithCustomError(prints, 'ProofAlreadyUsed');
    // Two distinct proofs via re-entry is just two legal mints, each charged correctly.
    await attacker.go(nonces.slice(0, 2), per, false, { value: per * 2n });
    expect(await prints.balanceOf(who)).to.equal(2n);
    expect(await prints.pressedBy(who)).to.equal(2n);
    const paid = await ethers.provider.getBalance(address);
    expect(paid).to.be.lessThanOrEqual(per * 2n);
    expect(paid).to.be.greaterThanOrEqual(FLOOR * 2n);
  });

  it('a minter that refuses its refund cannot mint with overpayment', async () => {
    const { prints, owner, address } = await deploy();
    await prints.connect(owner).openPress();
    const attacker = await ethers.deployContract('AttackMinter', [address]);
    const p = await grindFor(address, await attacker.getAddress(), 16);
    await expect(attacker.go([p.nonce], FLOOR * 4n, true, { value: FLOOR * 4n }))
      .to.be.revertedWithCustomError(prints, 'TransferFailed');
    // Exact payment needs no refund, so it goes through.
    await time.increase(HP.CONFIG.decaySeconds);
    await attacker.go([p.nonce], FLOOR, true, { value: FLOOR });
    expect(await prints.balanceOf(await attacker.getAddress())).to.equal(1n);
  });

  it('base URI can be locked for good', async () => {
    const { prints, owner, alice } = await deploy();
    await expect(prints.connect(alice).lockBaseURI()).to.be.revertedWithCustomError(prints, 'OwnableUnauthorizedAccount');
    await prints.connect(owner).setBaseURI('https://hashprints.vercel.app/api/meta/');
    await expect(prints.connect(owner).lockBaseURI()).to.emit(prints, 'BaseURILocked').withArgs('https://hashprints.vercel.app/api/meta/');
    expect(await prints.baseURILocked()).to.equal(true);
    await expect(prints.connect(owner).setBaseURI('https://evil.example/')).to.be.revertedWithCustomError(prints, 'BaseURIIsLocked');
  });

  it('ownership transfers in two steps', async () => {
    const { prints, owner, alice } = await deploy();
    await prints.connect(owner).transferOwnership(alice.address);
    expect(await prints.owner()).to.equal(owner.address); // not yet
    expect(await prints.pendingOwner()).to.equal(alice.address);
    await prints.connect(alice).acceptOwnership();
    expect(await prints.owner()).to.equal(alice.address);
  });

  it('owner controls: floor locked once open, withdraw', async () => {
    const { prints, owner, alice, address } = await deploy();
    await expect(prints.connect(owner).setFloorPrice(FLOOR * 2n)).to.emit(prints, 'FloorPriceSet').withArgs(FLOOR * 2n);
    await prints.connect(owner).setFloorPrice(FLOOR);
    await prints.connect(owner).openPress();
    await expect(prints.connect(owner).setFloorPrice(1n)).to.be.revertedWithCustomError(prints, 'PressAlreadyOpen');
    await expect(prints.connect(owner).openPress()).to.be.revertedWithCustomError(prints, 'PressAlreadyOpen');

    const proof = await grindFor(address, alice.address, 16);
    await prints.connect(alice).press(proof.nonce, { value: FLOOR * 4n });
    const bal = await ethers.provider.getBalance(address);
    await expect(prints.connect(alice).withdraw(alice.address)).to.be.revertedWithCustomError(prints, 'OwnableUnauthorizedAccount');
    await expect(prints.connect(owner).withdraw(ethers.ZeroAddress)).to.be.revertedWithCustomError(prints, 'ZeroAddress');
    await expect(prints.connect(owner).withdraw(owner.address)).to.changeEtherBalance(owner, bal);
  });

  (process.env.SLOW ? it : it.skip)('selling out a run re-opens the press hot and one notch harder every two runs', async () => {
    const { prints, owner, alice, address } = await deploy();
    await prints.connect(owner).openPress();
    expect(await prints.difficulty()).to.equal(16n);

    // Two prints per wallet, so spread the run across fresh funded wallets.
    let wallet, nonce = 0;
    for (let run = 0; run < 2; run++) {
      await time.increase(HP.CONFIG.decaySeconds); // run has cooled to the floor
      expect(await prints.currentPrice()).to.equal(FLOOR);
      let tx;
      for (let i = 0; i < 333; i++) {
        if (!wallet || (await prints.pressedBy(wallet.address)) === 2n) {
          wallet = ethers.Wallet.createRandom().connect(ethers.provider);
          await setBalance(wallet.address, ethers.parseEther('1'));
          nonce = 0;
        }
        const required = Number(await prints.difficulty());
        const proof = await grindFor(address, wallet.address, required, { startNonce: nonce, chunk: 1e9 });
        nonce = proof.nonce + 1;
        tx = await prints.connect(wallet).press(proof.nonce, { value: FLOOR * 4n });
      }
      // The run's last print re-inks the press: the clock resets, so the price is hot again.
      const block = await ethers.provider.getBlock((await tx.wait()).blockNumber);
      await expect(tx).to.emit(prints, 'RunStarted').withArgs(run + 1, 16 + Math.floor((run + 1) / 2), block.timestamp);
      expect(await prints.runStartedAt()).to.equal(BigInt(block.timestamp));
      expect(await prints.currentPrice()).to.be.greaterThan(FLOOR * 3n);
      expect(await prints.currentRun()).to.equal(BigInt(run + 1));
    }
    expect(await prints.difficulty()).to.equal(17n);
    expect(await prints.totalSupply()).to.equal(666n);
    expect(await prints.difficultyOf(336)).to.equal(16n);
    expect(await prints.difficultyOf(669)).to.equal(16n);
  });
});
