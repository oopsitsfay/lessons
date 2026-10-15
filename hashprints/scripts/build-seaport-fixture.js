// Rebuilds test/fixtures/seaport-1.6.json (Seaport 1.6 + ConduitController creation code) for the
// market tests. Seaport needs solc 0.8.24 with via-IR, so this runs outside Hardhat:
//   mkdir /tmp/sp && cd /tmp/sp && npm pack seaport-core@1.6.6 seaport-types@1.6.3 && npm i solc@0.8.24
//   tar xzf seaport-core-1.6.6.tgz && mkdir types && tar xzf seaport-types-1.6.3.tgz -C types
//   node <repo>/hashprints/scripts/build-seaport-fixture.js /tmp/sp
const fs = require('fs'), path = require('path');
const solc = require(require('path').join(process.argv[2] || process.cwd(), 'node_modules/solc'));
const D = process.argv[2] || process.cwd(), sources = {};
const walk = (dir, prefix) => { for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isDirectory()) walk(p, prefix + f + '/'); else if (f.endsWith('.sol')) sources[prefix + f] = { content: fs.readFileSync(p, 'utf8') }; } };
walk(path.join(D, 'package/src'), 'seaport-core/src/');
walk(path.join(D, 'types/package/src'), 'seaport-types/src/');
const input = { language: 'Solidity', sources, settings: { viaIR: true, evmVersion: 'cancun', optimizer: { enabled: true, runs: 4294967295 }, outputSelection: { 'seaport-core/src/Seaport.sol': { Seaport: ['abi', 'evm.bytecode.object'] }, 'seaport-core/src/conduit/ConduitController.sol': { ConduitController: ['evm.bytecode.object'] } } } };
const t = Date.now();
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) { console.log(errs.slice(0, 5).map((e) => e.formattedMessage).join('\n')); process.exit(1); }
fs.writeFileSync(path.join(__dirname, '../test/fixtures/seaport-1.6.json'), JSON.stringify({ seaport: out.contracts['seaport-core/src/Seaport.sol'].Seaport.evm.bytecode.object, conduitController: out.contracts['seaport-core/src/conduit/ConduitController.sol'].ConduitController.evm.bytecode.object }));
console.log('compiled in', (Date.now() - t) / 1000, 's');
