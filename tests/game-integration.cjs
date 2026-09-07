// Run explicitly with a save export: node tests/game-integration.cjs <save.txt>
// Loads the real upstream engine in memory; never imports into a live browser.
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const upstream = file => Buffer.from(JSON.parse(execFileSync('gh',
  ['api', `repos/Nuku/Emberhold/contents/js/${file}`], { encoding: 'utf8', maxBuffer: 4000000 })).content, 'base64').toString();
const context = vm.createContext({ console, window: {}, document: { querySelector: () => null } });
vm.runInContext(upstream('data.js'), context);
const engine = upstream('game.js');
vm.runInContext(engine.slice(0, engine.indexOf('// ---------- events ----------')), context);
context.saveInput = JSON.parse(Buffer.from(fs.readFileSync(process.argv[2], 'utf8').trim(), 'base64').toString());
vm.runInContext('state = {...defaultState(), ...saveInput}; state.day = 197550; state.pop = 47; state.jobs.miner = 43; state.res.food = 0; render = () => {};', context);
context.localStorage = { getItem: () => null };
const script = fs.readFileSync(path.join(__dirname, '..', 'emberhold_automation.user.js'), 'utf8');
vm.runInContext(script.replace('  boot();', '  window.runJobs = () => autoJobs(snapshot(), queuedDemand());'), context);
const api = context.window.emberhold;
const report = () => ({ jobs: api.getState().jobs, food: api.helpers.production(1).food,
  demand: api.helpers.queueDemand(), foodPerWorker: api.helpers.jobProduction('forager') });
console.log('Before:', JSON.stringify(report()));
context.window.runJobs();
console.log('After:', JSON.stringify(report()));
assert.ok(api.getState().jobs.forager > 4, 'Empty food and full stone must recruit foragers');
assert.ok(api.helpers.production(1).food > 0, 'Food must have a surplus after reassignment');
for (let i = 0; i < 20; i++) {
  context.window.runJobs();
  assert.ok(api.helpers.production(1).food > 0, 'Later plans must preserve food surplus');
}
api.actions.assign('miner', -1);
context.window.runJobs();
assert.ok(api.helpers.production(1).food > 0, 'Manual miner removal must not jeopardize food');
console.log('Real-engine save regression passed.');
