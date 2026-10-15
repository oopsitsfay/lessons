// Writes site/contract/: the ABI + bytecode the admin page deploys, and the exact compiler
// input for Etherscan's "Standard JSON Input" verification.
const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

(async () => {
  await hre.run('compile');
  const fq = 'contracts/HashPrints.sol:HashPrints';
  const artifact = await hre.artifacts.readArtifact(fq);
  const build = await hre.artifacts.getBuildInfo(fq);
  const out = path.join(__dirname, '..', 'site', 'contract');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'HashPrints.json'), JSON.stringify({
    contractName: artifact.contractName,
    compiler: build.solcLongVersion,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
  }) + '\n');
  fs.writeFileSync(path.join(out, 'HashPrints.standard-input.json'), JSON.stringify(build.input) + '\n');
  console.log('wrote', out, '·', build.solcLongVersion, '·', (artifact.bytecode.length - 2) / 2, 'bytes');
})();
