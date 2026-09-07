const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'emberhold_automation.user.js'), 'utf8');
function harness() {
  const state = { pop: 10, morale: 100, day: 1, res: {}, jobs: {}, diplomats: {},
    diplomacy: {}, techs: {}, bld: {}, expeditions: {}, queues: {} };
  const calls = [];
  const api = { getState: () => structuredClone(state), definitions: {}, helpers: {}, actions: {} };
  const context = vm.createContext({ window: { emberhold: api }, console,
    localStorage: { getItem: () => null }, document: { querySelector: () => null } });
  vm.runInContext(source.replace('  boot();', `
    window.test = { settings, invoke, autoJobs, autoMorale, autoBuildings,
      autoCraft, autoResearch, autoExpeditions, automationStep, availableWorkers, boot };
  `), context);
  function action(name, fn) {
    api.actions[name] = (...args) => { calls.push([name, ...args]); return fn(...args); };
  }
  return { state, api, calls, action, ...context.window.test, context };
}

test('each stage refreshes resources and preserves queued reserves', () => {
  const h = harness();
  Object.assign(h.settings, { jobs: false, crafting: false, expeditions: false });
  h.state.res.wood = 15;
  h.state.diplomacy.friend = { disposition: 20, request: { res: 'wood', amount: 5 } };
  h.api.helpers.queueDemand = () => ({ wood: 5 });
  h.api.definitions.BUILDINGS = [{ id: 'hut', max: 10, cost: { wood: 10 } }];
  h.action('build', () => { h.state.res.wood -= 10; h.state.bld.hut = 1; });
  h.action('supplyDiplomacyRequest', () => { h.state.res.wood -= 5; });
  h.automationStep();
  assert.deepEqual(h.calls, [['build', 'hut']]);
  assert.equal(h.state.res.wood, 5);
});

test('building dependencies obey the Crafting toggle', () => {
  const h = harness();
  h.settings.crafting = false;
  h.state.res.wood = 40;
  h.api.definitions.BUILDINGS = [{ id: 'hut', max: 10, cost: { tools: 1 } }];
  h.api.definitions.CRAFTS = [{ id: 'tools', cost: { wood: 40 }, give: { tools: 1 } }];
  h.action('craft', () => { h.state.res.tools = 1; });
  h.autoBuildings(h.api.getState(), {});
  assert.deepEqual(h.calls, []);
});

test('targeted workers are never ordinary reassignment donors', () => {
  const h = harness();
  h.state.pop = 3;
  h.state.jobs = { forager: 1, performer: 1, explorer: 1 };
  h.api.definitions.JOBS = { forager: { res: 'food', base: 1 },
    woodcutter: { res: 'wood', base: 1 }, performer: { targeted: true }, explorer: { targeted: true } };
  h.action('assign', () => {});
  h.autoJobs(h.api.getState(), {});
  assert.deepEqual(h.calls, []);
});

test('automatic guards do not consume population slots', () => {
  const h = harness();
  h.state.jobs = { forager: 5, guard: 20, performer: 1 };
  h.state.diplomats = { friend: 1 };
  assert.equal(h.availableWorkers(h.state), 3);
  h.api.helpers.unassigned = () => 2;
  assert.equal(h.availableWorkers(h.state), 2);
});

test('zero-production diplomats pause and resume through the legacy API', () => {
  const h = harness();
  h.api.definitions.JOBS = { diplomat: { targeted: true, base: 0, res: 'currency' } };
  h.api.helpers.jobProduction = () => 0;
  h.state.diplomats.friend = 1;
  h.state.diplomacy.friend = { disposition: 100 };
  h.api.action = (name, id, delta) => {
    h.calls.push([name, id, delta]); h.state.diplomats[id] += delta;
  };
  h.autoJobs(h.api.getState(), {});
  h.state.diplomacy.friend.disposition = 99;
  h.autoJobs(h.api.getState(), {});
  assert.deepEqual(h.calls, [['assignDiplomat', 'friend', -1], ['assignDiplomat', 'friend', 1]]);
});

test('failed diplomat removal does not create a replacement obligation', () => {
  const h = harness();
  h.api.definitions.JOBS = { diplomat: { targeted: true } };
  h.state.diplomats.friend = 1;
  h.state.diplomacy.friend = { disposition: 100 };
  h.action('assignDiplomat', () => {});
  h.autoJobs(h.api.getState(), {});
  h.state.diplomacy.friend.disposition = 99;
  h.autoJobs(h.api.getState(), {});
  assert.deepEqual(h.calls, [['assignDiplomat', 'friend', -1]]);
});

test('no-op and explicitly rejected actions report failure', () => {
  const h = harness();
  h.action('craft', () => {});
  assert.equal(h.invoke('craft', 'tools'), false);
  h.action('setJob', () => false);
  assert.equal(h.invoke('setJob', 'forager', 2), false);
});

test('job assignment falls back when the bulk setter does not change the job', () => {
  const h = harness();
  h.state.pop = 3;
  h.state.res.food = 0;
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    woodcutter: { res: 'wood', base: 1 },
  };
  h.action('setJob', () => {});
  h.action('assign', (id, delta) => {
    h.state.jobs[id] = (h.state.jobs[id] || 0) + delta;
  });
  h.autoJobs(h.api.getState(), {});
  assert.deepEqual(h.calls, [
    ['setJob', 'forager', 3],
    ['assign', 'forager', 1],
    ['assign', 'forager', 1],
    ['assign', 'forager', 1],
  ]);
  assert.equal(h.state.jobs.forager, 3);
});

test('worker releases finish when bulk decrease is only partially applied', () => {
  const h = harness();
  h.state.pop = 4;
  h.state.jobs = { forager: 1, miner: 3 };
  h.state.res = { food: 0, stone: 100 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    miner: { res: 'stone', base: 1 },
  };
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.production = () => ({ food: -10, stone: 1 });
  h.action('setJob', (id, total) => {
    h.state.jobs[id] = id === 'miner' ? Math.max(total, h.state.jobs[id] - 1) : total;
  });
  h.action('assign', (id, delta) => { h.state.jobs[id] += delta; });

  h.autoJobs(h.api.getState(), {});

  assert.equal(h.state.jobs.miner, 0);
  assert.equal(h.state.jobs.forager, 4);
});

test('food workers settle at sustainable production across repeated ticks', () => {
  const h = harness();
  h.state.pop = 31;
  h.state.jobs = { forager: 30, woodcutter: 1 };
  h.state.res = { food: 2436, wood: 100 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 }, woodcutter: { res: 'wood', base: 1 },
  };
  h.api.helpers.jobProduction = () => 2;
  h.api.helpers.production = () => ({ food: h.state.jobs.forager * 2 - 31, wood: 2 });
  h.action('setJob', (id, count) => { h.state.jobs[id] = count; });
  h.action('assign', (id, delta) => { h.state.jobs[id] += delta; });
  for (let i = 0; i < 60; i++) h.autoJobs(h.api.getState(), {});
  assert.equal(h.state.jobs.forager, 16);
  const settledCalls = h.calls.length;
  for (let i = 0; i < 10; i++) h.autoJobs(h.api.getState(), {});
  assert.equal(h.calls.length, settledCalls);
  // A season change requires more food workers without allocating every idle worker.
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.production = () => ({ food: h.state.jobs.forager - 20, wood: 1 });
  for (let i = 0; i < 30; i++) h.autoJobs(h.api.getState(), {});
  assert.equal(h.state.jobs.forager, 20);
});

test('starvation overrides non-food sustaining floors', () => {
  const h = harness();
  h.state.pop = 54;
  h.state.jobs = { forager: 4, guard: 12, miner: 50 };
  h.state.res = { food: 0, stone: 3915 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 0.55 },
    miner: { res: 'stone', base: 0.28 },
  };
  h.api.helpers.capacityOf = () => 3915;
  h.api.helpers.jobProduction = id => id === 'forager' ? 0.55 : 0.28;
  h.api.helpers.production = () => ({ food: -0.41, stone: 20.7 });
  h.action('setJob', (id, total) => { h.state.jobs[id] = total; });

  h.autoJobs(h.api.getState(), {});

  assert.equal(h.state.jobs.miner, 0);
  assert.equal(h.state.jobs.forager, 54);
});

test('unmet jobs are filled together with bulk totals', () => {
  const h = harness();
  h.state.pop = 5;
  h.state.res = { food: 46, stone: 47 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 2 }, miner: { res: 'stone', base: 1 },
  };
  h.api.helpers.capacityOf = () => 100;
  h.api.helpers.jobProduction = id => id === 'forager' ? 2 : 1;
  h.api.helpers.production = () => ({ food: 0, stone: 0 });
  h.action('setJob', (id, total) => { h.state.jobs[id] = total; });
  h.autoJobs(h.api.getState(), {});
  assert.deepEqual(h.calls, [['setJob', 'forager', 2], ['setJob', 'miner', 3]]);
});

test('queued crafted outputs are supplied beyond one batch', () => {
  const h = harness();
  h.state.res = { tools: 2, wood: 80 };
  h.api.definitions.CRAFTS = [{ id: 'tools', cost: { wood: 40 }, give: { tools: 1 } }];
  h.action('craft', () => { h.state.res.wood -= 40; h.state.res.tools++; });
  h.autoCraft(h.api.getState(), { tools: 3, wood: 40 });
  assert.equal(h.state.res.tools, 3);
  assert.equal(h.state.res.wood, 40);
  h.autoCraft(h.api.getState(), { tools: 3, wood: 40 });
  assert.equal(h.calls.length, 1);
});

test('full outputs and Tinkering restrictions do not stall later buildings', () => {
  for (const full of [true, false]) {
    const h = harness();
    h.state.res = { tools: full ? 1 : 0, wood: 100 };
    if (!full) h.state.trial = { id: 'tinkering' };
    h.api.helpers.capacityOf = () => 1;
    h.api.definitions.CRAFTS = [{ id: 'tools', cost: { wood: 40 }, give: { tools: 1 } }];
    h.api.definitions.BUILDINGS = [
      { id: 'hut', cost: { tools: 2 }, max: 5 },
      { id: 'storehouse', cost: { wood: 10 }, max: 5 },
    ];
    h.action('build', id => { h.state.bld[id] = 1; });
    h.autoBuildings(h.api.getState(), {});
    assert.deepEqual(h.calls, [['build', 'storehouse']]);
  }
});

test('expeditions use discounted costs and craft dependencies', () => {
  const h = harness();
  h.api.definitions.EXPEDITIONS = [{ id: 'roads', reqPop: 1, cost: { wood: 100 } }];
  h.api.helpers.expeditionCost = () => ({ wood: 75 });
  h.state.res.wood = 75;
  h.action('expedition', id => { h.state.expeditions[id] = true; });
  h.autoExpeditions(h.api.getState(), {});
  assert.deepEqual(h.calls, [['expedition', 'roads']]);
  h.state.expeditions = {};
  h.api.helpers.expeditionCost = () => ({ tools: 2 });
  h.api.definitions.CRAFTS = [{ id: 'tools', cost: { wood: 40 }, give: { tools: 1 } }];
  h.action('craft', () => { h.state.res.tools = 1; });
  h.autoExpeditions(h.api.getState(), {});
  assert.deepEqual(h.calls[1], ['craft', 'tools']);
});

test('queued research and buildings are not duplicated', () => {
  const h = harness();
  h.state.res = { knowledge: 100, wood: 100 };
  h.state.queues = { build: [{ id: 'hut' }], research: [{ id: 'writing' }] };
  h.api.definitions.TECHS = [{ id: 'writing', cost: 10 }];
  h.api.definitions.BUILDINGS = [{ id: 'hut', max: 10, cost: { wood: 10 } }];
  h.action('build', () => {});
  h.action('research', () => {});
  h.autoResearch(h.api.getState(), {});
  h.autoBuildings(h.api.getState(), {});
  assert.deepEqual(h.calls, []);
});

test('morale assignments do not skip research for the tick', () => {
  const h = harness();
  h.state.morale = 50;
  h.state.res.knowledge = 10;
  h.api.definitions.JOBS = { performer: { targeted: true } };
  h.api.definitions.TECHS = [{ id: 'writing', cost: 10 }];
  h.action('assignPerformer', () => { h.state.jobs.performer = 1; });
  h.action('research', () => { h.state.techs.writing = true; });
  h.automationStep();
  assert.equal(h.state.techs.writing, true);
});

test('boot works without an event subscription API', () => {
  const h = harness();
  h.context.document.getElementById = () => ({});
  h.context.setInterval = () => 1;
  assert.doesNotThrow(() => h.boot());
});
