// node tests/factory-integration.cjs <game-directory> <save-export.txt>
// Exercise the real API and selection toggles without changing the live game.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const context = vm.createContext({ console, window: {},
  document: { querySelector: () => null }, localStorage: { getItem: () => null } });
const readGame = file => fs.readFileSync(path.join(process.argv[2], 'js', file), 'utf8');
vm.runInContext(readGame('data.js'), context);
const engine = readGame('game.js');
vm.runInContext(engine.slice(0, engine.indexOf('// ---------- events ----------')), context);
context.save = JSON.parse(Buffer.from(fs.readFileSync(process.argv[3], 'utf8').trim(), 'base64').toString());
vm.runInContext('state = {...defaultState(), ...save}; render = () => {};', context);
const source = fs.readFileSync(path.join(__dirname, '..', 'emberhold_automation.user.js'), 'utf8');
vm.runInContext(source.replace('  boot();', `window.factoryTest = {
  demand: queuedDemand,
  run: () => { autoFactory(snapshot(), queuedDemand()); autoPower(snapshot(), queuedDemand()); }
};`), context);
const api = context.window.emberhold;
// A later ordinary building must not inflate the strict queue's head demand.
vm.runInContext("state.queues.build.push({type:'build', id:'airControlStage'}); state.res.steel = 0.2;", context);
assert.equal(context.window.factoryTest.demand().steel, 900);
assert.equal(context.window.factoryTest.demand().machinery, 240);
context.window.factoryTest.run();
const result = api.getState();
assert.deepEqual(Array.from(result.factoryRecipes), ['steel', 'machinery']);
assert.equal(result.power.buildings.factory.enabled, result.bld.factory);
assert.equal(result.power.buildings.factory.active, result.bld.factory);
assert.equal(result.power.buildings.aluminumWorks.enabled, result.bld.aluminumWorks);
context.window.factoryTest.run();
assert.deepEqual(Array.from(api.getState().factoryRecipes), ['steel', 'machinery']);
console.log('Real-save production regression passed: Steel + Machinery selected; all factories powered.');
