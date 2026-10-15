require('@nomicfoundation/hardhat-toolbox');
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');

const SOLC_VERSION = '0.8.28';

// Use the solc-js build bundled in node_modules instead of downloading a compiler.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion !== SOLC_VERSION) return runSuper();
  const solc = require('solc');
  return {
    compilerPath: require.resolve('solc/soljson.js'),
    isSolcJs: true,
    version: SOLC_VERSION,
    longVersion: solc.version(),
  };
});

module.exports = {
  solidity: { version: SOLC_VERSION, settings: { evmVersion: 'cancun', optimizer: { enabled: true, runs: 200 } } },
};
