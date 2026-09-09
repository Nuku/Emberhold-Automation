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
    window.test = { settings, invoke, autoJobs, autoMorale, autoBuildings, autoFactory, autoPower,
      autoCraft, autoResearch, autoExpeditions, autoWonderStart, autoWonderHandle,
      automationStep, queuedDemand,
      availableWorkers, boot };
  `), context);
  function action(name, fn) {
    api.actions[name] = (...args) => { calls.push([name, ...args]); return fn(...args); };
  }
  return { state, api, calls, action, ...context.window.test, context };
}

function powerHarness(generated = 3, housing = 0) {
  const h = harness();
  h.state.bld.factory = 1;
  h.state.buildingPower = { quarry: 5, coalSeam: 0 };
  h.api.helpers.capacityOf = () => 100;
  h.api.helpers.production = () => ({ stone: 1, coal: -1 });
  h.api.getPower = () => {
    let available = Math.max(0, generated - housing);
    const buildings = {};
    for (const [id, resource] of [['quarry', 'stone'], ['coalSeam', 'coal']]) {
      const enabled = h.state.buildingPower[id];
      const active = Math.min(enabled, Math.floor((available + 1e-9) / 0.2));
      available -= active * 0.2;
      buildings[id] = { built: 5, enabled, active, used: active * 0.2,
        powerPerBuilding: 0.2, resource, productionBonus: active * 0.1 };
    }
    return { generated, used: housing + Object.values(buildings).reduce((sum, b) => sum + b.used, 0), buildings };
  };
  h.action('setBuildingPower', (id, count) => { h.state.buildingPower[id] = count; });
  return h;
}

test('new power telemetry controls Living Blocks and Factories too', () => {
  const h = powerHarness(2.5);
  h.state.bld = { livingBlock: 1, factory: 1 };
  h.state.buildingPower = { livingBlock: 1, quarry: 5, coalSeam: 0, factory: 1 };
  h.api.getPower = () => ({ generated: 2.5, used: 2.5, buildings: {
    livingBlock: { built: 1, enabled: h.state.buildingPower.livingBlock, active: h.state.buildingPower.livingBlock, used: 1, powerPerBuilding: 1 },
    quarry: { built: 5, enabled: h.state.buildingPower.quarry, active: 5, used: 1, powerPerBuilding: .2, resource: 'stone' },
    factory: { built: 1, enabled: h.state.buildingPower.factory, active: h.state.buildingPower.factory, used: 1.5, powerPerBuilding: 1.5 },
  }});
  h.action('setBuildingPower', (id, count) => { h.state.buildingPower[id] = count; });
  h.autoPower(h.api.getState(), { stone: 10 });
  assert.deepEqual(h.calls, [['setBuildingPower', 'factory', 0]]);
  assert.equal(h.state.buildingPower.livingBlock, 1);
  assert.equal(h.state.buildingPower.factory, 0);
});

test('power reserves factory capacity and sheds before enabling priority sites', () => {
  const h = powerHarness();
  h.autoPower(h.api.getState(), {});
  assert.deepEqual(h.calls, [['setBuildingPower', 'quarry', 2], ['setBuildingPower', 'coalSeam', 5]]);
  assert.ok(h.api.getPower().generated - h.api.getPower().used >= 1.5);
  h.autoPower(h.api.getState(), {});
  assert.equal(h.calls.length, 2, 'stable allocation must not issue repeated setters');
});

test('factories retask to produce queued outputs and their factory-made inputs', () => {
  const h = harness();
  h.state.bld.factory = 1;
  h.state.techs = { craftsmanship: true, metallurgy: true, machineryTech: true };
  h.state.factoryRecipe = 'goods';
  h.action('chooseFactoryRecipe', id => { h.state.factoryRecipe = id; });

  h.autoFactory(h.api.getState(), { tools: 1 });
  assert.deepEqual(h.calls, [['chooseFactoryRecipe', 'tools']]);

  h.calls.length = 0;
  h.state.factoryRecipe = 'goods';
  h.autoFactory(h.api.getState(), { machinery: 1 });
  assert.deepEqual(h.calls, [['chooseFactoryRecipe', 'steel']],
    'Machinery must first stock the Steel its factory line consumes');

  h.calls.length = 0;
  h.state.res.steel = 1;
  h.autoFactory(h.api.getState(), { machinery: 1 });
  assert.deepEqual(h.calls, [['chooseFactoryRecipe', 'machinery']]);
});

test('housing and a factory shortfall switch off optional loads', () => {
  const h = powerHarness(2, 1);
  h.autoPower(h.api.getState(), {});
  assert.deepEqual(h.calls, [['setBuildingPower', 'quarry', 0]]);
});

test('power allocates whole buildings and prioritizes unmet queued resources', () => {
  const h = powerHarness(0.6);
  h.state.bld.factory = 0;
  h.api.helpers.production = () => ({ stone: 1, coal: 1 });
  h.autoPower(h.api.getState(), { stone: 10 });
  assert.equal(h.state.buildingPower.quarry, 3);
  assert.equal(h.state.buildingPower.coalSeam, 0);
});

test('full storage releases power and zero generation disables all optional loads', () => {
  const h = powerHarness();
  h.state.res.stone = 100;
  h.autoPower(h.api.getState(), {});
  assert.equal(h.state.buildingPower.quarry, 0);
  assert.equal(h.state.buildingPower.coalSeam, 5);
  const empty = powerHarness(0);
  empty.autoPower(empty.api.getState(), {});
  assert.equal(empty.state.buildingPower.quarry, 0);
});

test('failed and partially applied load shedding never enables replacement loads', () => {
  for (const partial of [false, true]) {
    const h = powerHarness();
    h.action('setBuildingPower', () => {
      if (partial) h.state.buildingPower.quarry = 4;
      return partial;
    });
    h.autoPower(h.api.getState(), {});
    assert.deepEqual(h.calls, [['setBuildingPower', 'quarry', 2]]);
  }
});

test('power toggle and missing or invalid telemetry perform no mutations', () => {
  const h = powerHarness();
  for (const key of Object.keys(h.settings)) h.settings[key] = false;
  h.settings.enabled = true;
  h.automationStep();
  assert.deepEqual(h.calls, []);
  delete h.api.getPower;
  h.autoPower(h.api.getState(), {});
  h.state.power = { generated: NaN, used: 0, buildings: {} };
  h.autoPower(h.api.getState(), {});
  assert.deepEqual(h.calls, []);
});

test('snapshot telemetry and legacy action dispatcher are supported', () => {
  const h = powerHarness();
  const getPower = h.api.getPower;
  h.api.getState = () => structuredClone({ ...h.state, power: getPower() });
  delete h.api.getPower;
  const setter = h.api.actions.setBuildingPower;
  delete h.api.actions.setBuildingPower;
  h.api.action = (name, ...args) => setter(...args);
  h.autoPower(h.api.getState(), {});
  assert.equal(h.state.buildingPower.coalSeam, 5);
});

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

test('strict queue order reserves only the first item in each queue', () => {
  const h = harness();
  h.state.settings = { strictQueueOrder: true };
  h.state.queues = {
    build: [{ type: 'build', id: 'hut' }, { type: 'build', id: 'workshop' }],
    research: [{ type: 'research', id: 'writing' }, { type: 'research', id: 'masonry' }],
    expedition: [{ type: 'expedition', id: 'scout' }, { type: 'expedition', id: 'mine' }],
  };
  h.api.definitions.BUILDINGS = [
    { id: 'hut', cost: { wood: 10 } }, { id: 'workshop', cost: { wood: 20 } },
  ];
  h.api.definitions.TECHS = [
    { id: 'writing', cost: 3 }, { id: 'masonry', cost: 5 },
  ];
  h.api.definitions.EXPEDITIONS = [
    { id: 'scout', cost: { food: 4 } }, { id: 'mine', cost: { food: 8 } },
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(h.queuedDemand(h.state))),
    { wood: 10, knowledge: 3, food: 4 });
});

test('research queue demand includes every research resource', () => {
  const h = harness();
  h.state.settings = { strictQueueOrder: true };
  h.state.queues.research = [{ id: 'engineering' }];
  h.api.definitions.TECHS = [{ id: 'engineering', cost: { knowledge: 3, wood: 7, tools: 1 } }];
  assert.deepEqual(JSON.parse(JSON.stringify(h.queuedDemand(h.state))),
    { knowledge: 3, wood: 7, tools: 1 });
});

test('research waits for non-knowledge resources', () => {
  const h = harness();
  h.state.res = { knowledge: 10, wood: 0 };
  h.api.definitions.TECHS = [{ id: 'engineering', cost: { knowledge: 10, wood: 5 } }];
  h.action('research', id => { h.state.techs[id] = true; });
  h.autoResearch(h.api.getState(), {});
  assert.deepEqual(h.calls, []);
  h.state.res.wood = 5;
  h.autoResearch(h.api.getState(), {});
  assert.deepEqual(h.calls, [['research', 'engineering']]);
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

test('an idle villager starts exploring', () => {
  const h = harness();
  h.state.pop = 3;
  h.state.res.food = 1;
  h.state.jobs = { forager: 1, explorer: 0 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    explorer: { targeted: true },
  };
  h.action('assignExplorer', delta => { h.state.jobs.explorer += delta; });
  h.autoJobs(h.api.getState(), {});
  assert.equal(h.state.jobs.explorer, 1);
  assert.deepEqual(h.calls, [['assignExplorer', 1]]);
});

test('wonder start waits for the beacon revisit and preserves queued demand', () => {
  const h = harness();
  h.settings.wonderStart = true;
  h.state.landing = 'emberplain';
  h.state.bld = { barracks: 1 };
  h.state.jobs = { guard: 2 };
  h.state.guardInjuries = 0;
  h.state.techs = { optics: true };
  h.state.beaconsLit = { emberplain: true };
  h.state.beaconRevisited = { emberplain: true };
  h.state.surveyPoints = 18;
  h.state.res = { wood: 9 };
  h.state.wonders = { emberplain: { found: false, outcomes: {} } };
  h.api.definitions.WONDERS = [{ id: 'emberplain', findCost: { survey: 10, wood: 5 } }];
  h.action('findWonder', () => { h.state.wonders.emberplain.found = true; });
  h.autoWonderStart(h.api.getState(), {});
  assert.deepEqual(h.calls, [['findWonder']]);
});

test('wonder automation waits for a full healthy Guard force', () => {
  const h = harness();
  h.settings.wonderStart = true;
  h.state.landing = 'emberplain';
  h.state.bld = { barracks: 1 };
  h.state.jobs = { guard: 0 };
  h.state.guardInjuries = 1;
  h.state.techs = { optics: true };
  h.state.beaconsLit = { emberplain: true };
  h.state.beaconRevisited = { emberplain: true };
  h.state.surveyPoints = 100;
  h.state.res = { wood: 100 };
  h.state.wonders = { emberplain: { found: false, outcomes: {} } };
  h.api.definitions.WONDERS = [{ id: 'emberplain', findCost: { survey: 10, wood: 5 } }];
  h.action('findWonder', () => { h.state.wonders.emberplain.found = true; });
  h.autoWonderStart(h.api.getState(), {});
  assert.deepEqual(h.calls, []);
});

test('wonder handling fills available Rapture capacity but leaves the fate manual', () => {
  const h = harness();
  h.settings.wonderHandle = true;
  h.state.pop = 5;
  h.state.jobs = { forager: 1, guard: 2 };
  h.state.bld = { barracks: 1 };
  h.state.guardInjuries = 0;
  h.state.landing = 'emberplain';
  h.state.wonders = { emberplain: { found: true, sections: [false, false, false, false, false],
    progress: 0, researches: {}, expeditions: {} } };
  h.action('assignRapture', delta => {
    h.state.rapture = { landing: 'emberplain', workers: delta };
  });
  h.autoWonderHandle(h.api.getState());
  assert.deepEqual(h.calls, [['assignRapture', 4]]);
});

test('wonder handling reclaims ordinary workers when no villagers are idle', () => {
  const h = harness();
  h.settings.wonderHandle = true;
  h.state.pop = 5;
  h.state.landing = 'emberplain';
  h.state.bld = { barracks: 1 };
  h.state.jobs = { forager: 1, woodcutter: 4, guard: 2 };
  h.state.wonders = { emberplain: { found: true, sections: [false, false, false, false, false],
    progress: 0, researches: {}, expeditions: {} } };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 }, woodcutter: { res: 'wood', base: 1 }, guard: {},
  };
  h.action('setJob', (id, count) => { h.state.jobs[id] = count; });
  h.action('assignRapture', delta => {
    h.state.rapture = { landing: 'emberplain', workers: delta };
  });
  h.autoWonderHandle(h.api.getState());
  assert.deepEqual(h.calls, [['setJob', 'woodcutter', 0], ['assignRapture', 4]]);
});

test('wonder handling preserves workers producing resources needed by queued work', () => {
  const h = harness();
  h.settings.wonderHandle = true;
  h.state.pop = 5;
  h.state.landing = 'emberplain';
  h.state.bld = { barracks: 1 };
  h.state.jobs = { forager: 1, woodcutter: 4, guard: 2 };
  h.state.wonders = { emberplain: { found: true, sections: [false, false, false, false, false],
    progress: 0, researches: {}, expeditions: {} } };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 }, woodcutter: { res: 'wood', base: 1 }, guard: {},
  };
  h.action('setJob', (id, count) => { h.state.jobs[id] = count; });
  h.action('assignRapture', delta => {
    h.state.rapture = { landing: 'emberplain', workers: delta };
  });
  h.autoWonderHandle(h.api.getState(), { wood: 10 });
  assert.deepEqual(h.calls, []);
});

test('wonder handling uses the public research, obstacle, and expedition actions', () => {
  const h = harness();
  h.settings.wonderHandle = true;
  h.state.landing = 'emberplain';
  h.state.jobs = { guard: 1 };
  h.state.wonders = { emberplain: { found: true, sections: [false, false, false, false, false],
    progress: 0, researches: {}, expeditions: {} } };
  h.action('wonderResearch', index => { h.state.wonders.emberplain.researches[index] = true; });
  h.autoWonderHandle(h.api.getState());
  assert.deepEqual(h.calls, [['wonderResearch', 0]]);

  h.calls.length = 0;
  h.state.wonders.emberplain.researches[0] = true;
  h.action('wonderExpedition', index => { h.state.wonders.emberplain.expeditions[index] = true; });
  h.autoWonderHandle(h.api.getState());
  assert.deepEqual(h.calls, [['wonderExpedition', 0]]);

  h.calls.length = 0;
  h.state.wonders.emberplain.expeditions[0] = true;
  h.action('wonderObstacle', () => { h.state.wonders.emberplain.obstacles = { '0:0': true }; });
  h.autoWonderHandle(h.api.getState());
  assert.deepEqual(h.calls, [['wonderObstacle']]);
});

test('wonder handling withdraws to two workers while an obstacle is queued', () => {
  const h = harness();
  h.settings.wonderHandle = true;
  h.state.landing = 'grayrocks';
  h.state.jobs = { guard: 3 };
  h.state.rapture = { landing: 'grayrocks', workers: 6 };
  h.state.queues = { build: [{ type: 'build', id: 'wonderObstacle:grayrocks:2:0' }] };
  h.state.wonders = { grayrocks: { found: true, sections: [true, true, false, false, false],
    progress: 20, researches: {}, expeditions: {}, obstacles: {} } };
  h.action('assignRapture', delta => { h.state.rapture.workers += delta; });
  h.autoWonderHandle(h.api.getState());
  assert.deepEqual(h.calls, [['assignRapture', -4]]);
  assert.equal(h.state.rapture.workers, 2);
});

test('wonder handling replenishes the two-worker obstacle foothold after a loss', () => {
  const h = harness();
  h.settings.wonderHandle = true;
  h.state.pop = 5;
  h.state.landing = 'grayrocks';
  h.state.jobs = { forager: 1, woodcutter: 3, guard: 3 };
  h.state.rapture = { landing: 'grayrocks', workers: 1 };
  h.state.queues = { build: [{ type: 'build', id: 'wonderObstacle:grayrocks:2:0' }] };
  h.state.wonders = { grayrocks: { found: true, sections: [true, true, false, false, false],
    progress: 20, researches: {}, expeditions: {}, obstacles: {} } };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 }, woodcutter: { res: 'wood', base: 1 }, guard: {},
  };
  h.action('setJob', (id, count) => { h.state.jobs[id] = count; });
  h.action('assignRapture', delta => { h.state.rapture.workers += delta; });
  h.api.helpers.unassigned = () => h.state.pop - h.state.jobs.forager -
    h.state.jobs.woodcutter - h.state.rapture.workers;
  h.autoWonderHandle(h.api.getState(), {});
  assert.deepEqual(h.calls, [['setJob', 'woodcutter', 2], ['assignRapture', 1]]);
  assert.equal(h.state.rapture.workers, 2);
});

test('automatic guards do not consume population slots', () => {
  const h = harness();
  h.state.jobs = { forager: 5, guard: 20, performer: 1 };
  h.state.diplomats = { friend: 1 };
  assert.equal(h.availableWorkers(h.state), 3);
  h.api.helpers.unassigned = () => 2;
  assert.equal(h.availableWorkers(h.state), 2);
});

test('low coal stock protects coal diggers from input-limited industry oscillation', () => {
  const h = harness();
  h.state.pop = 10;
  h.state.res.coal = 20;
  h.state.jobs = { forager: 1, digger: 5 };
  h.state.bld = { forge: 2 };
  h.api.helpers.capacityOf = id => id === 'coal' ? 100 : 1000;
  h.api.helpers.production = () => ({ food: 1, coal: 1 });
  h.api.helpers.jobProduction = id => id === 'digger' ? 0.1 : 1;
  h.api.helpers.jobCapacity = id => id === 'digger' ? 5 : NaN;
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    digger: { res: 'coal', base: 0.1, max: () => 5 },
  };
  h.action('assign', () => {});
  h.action('setJob', () => {});
  h.autoJobs(h.api.getState(), {});
  assert.equal(h.calls.some(([name, id, amount]) =>
    id === 'digger' && amount < 0), false);
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
  h.api.helpers.production = () => ({ food: -2 });
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

  assert.equal(h.state.jobs.miner, 49);
  assert.equal(h.state.jobs.forager, 5);
});

test('surplus workers are assigned to thinkers up to their cap', () => {
  const h = harness();
  h.state.pop = 10;
  h.state.jobs = { forager: 1, woodcutter: 1 };
  h.state.res = { food: 100, wood: 100, knowledge: 100 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    woodcutter: { res: 'wood', base: 1 },
    thinker: { res: 'knowledge', base: 1 },
  };
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.jobCapacity = id => id === 'thinker' ? 3 : 10;
  h.api.helpers.production = () => ({ food: 1, wood: 1, knowledge: 0 });
  h.action('setJob', (id, total) => { h.state.jobs[id] = total; });

  h.autoJobs(h.api.getState(), {});

  assert.equal(h.state.jobs.thinker, 3);
});

test('thinkers take priority over non-food stockpiling', () => {
  const h = harness();
  h.state.pop = 10;
  h.state.jobs = { forager: 1, woodcutter: 5 };
  h.state.res = { food: 100, wood: 0, knowledge: 100 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    woodcutter: { res: 'wood', base: 1 },
    thinker: { res: 'knowledge', base: 1 },
  };
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.jobCapacity = id => id === 'thinker' ? 4 : 10;
  h.api.helpers.production = () => ({ food: 1, wood: 0, knowledge: 0 });
  h.action('setJob', (id, total) => { h.state.jobs[id] = total; });

  h.autoJobs(h.api.getState(), {});

  assert.equal(h.state.jobs.thinker, 4);
  assert.equal(h.state.jobs.woodcutter, 5);
});

test('limited jobs fill before queued resource staffing', () => {
  const h = harness();
  h.state.pop = 5;
  h.state.jobs = { forager: 1 };
  h.state.res = { food: 100, wood: 0, stone: 100 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    woodcutter: { res: 'wood', base: 1 },
    miner: { res: 'stone', base: 1 },
  };
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.jobCapacity = id => id === 'miner' ? 2 : 10;
  h.api.helpers.production = () => ({ food: 1, wood: 0, stone: 0 });
  h.action('setJob', (id, total) => { h.state.jobs[id] = total; });

  h.autoJobs(h.api.getState(), { wood: 100 });

  assert.equal(h.state.jobs.miner, 2);
});

test('queue demand does not retry a job that is already at capacity', () => {
  const h = harness();
  h.state.pop = 8;
  h.state.jobs = { forager: 1, miner: 4 };
  h.state.res = { food: 100, stone: 0, wood: 100 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    miner: { res: 'stone', base: 1 },
    woodcutter: { res: 'wood', base: 1 },
  };
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.jobCapacity = id => id === 'miner' ? 4 : 8;
  h.api.helpers.production = () => ({ food: 1, stone: 0, wood: 1 });
  h.action('setJob', (id, total) => { h.state.jobs[id] = total; });

  h.autoJobs(h.api.getState(), { stone: 100 });

  assert.ok(h.calls.every(call => call[1] !== 'miner'));
  assert.equal(h.state.jobs.miner, 4);
});

test('remaining workers fill a useful open job after priority allocations', () => {
  const h = harness();
  h.state.pop = 8;
  h.state.jobs = { forager: 1 };
  h.state.res = { food: 100, wood: 100, stone: 100 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    woodcutter: { res: 'wood', base: 1 },
    miner: { res: 'stone', base: 1 },
  };
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.jobCapacity = id => id === 'miner' ? 2 : 8;
  h.api.helpers.production = () => ({ food: 1, wood: 1, stone: 0 });
  h.action('setJob', (id, total) => { h.state.jobs[id] = total; });

  h.autoJobs(h.api.getState(), { wood: 1 });

  assert.equal(h.state.jobs.miner, 2);
  assert.equal(h.state.jobs.woodcutter, 5);
  assert.equal(h.availableWorkers(h.state), 0);
});

test('idle workers use open background jobs when no queue has priority', () => {
  const h = harness();
  h.state.pop = 5;
  h.state.jobs = { forager: 1 };
  h.state.res = { food: 100, wood: 100 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    woodcutter: { res: 'wood', base: 1 },
  };
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.production = () => ({ food: 1, wood: 1 });
  h.action('setJob', (id, total) => { h.state.jobs[id] = total; });

  h.autoJobs(h.api.getState(), {});

  assert.equal(h.state.jobs.woodcutter, 4);
  assert.equal(h.availableWorkers(h.state), 0);
});

test('food emergency reclaims the only thinker for foraging', () => {
  const h = harness();
  h.state.pop = 1;
  h.state.jobs = { thinker: 1 };
  h.state.res = { food: 0, knowledge: 100 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    thinker: { res: 'knowledge', base: 1, max: 1 },
  };
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.production = () => ({ food: -1, knowledge: 1 });
  h.action('setJob', (id, total) => { h.state.jobs[id] = total; });

  h.autoJobs(h.api.getState(), {});

  assert.equal(h.state.jobs.thinker, 0);
  assert.equal(h.state.jobs.forager, 1);
});

test('zero effective output does not override game production restrictions', () => {
  const h = harness();
  h.state.pop = 6;
  h.state.jobs = { forager: 4, miner: 2 };
  h.state.res = { food: 0, stone: 100 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 0.55 },
    miner: { res: 'stone', base: 0.28 },
  };
  h.api.helpers.jobProduction = id => id === 'forager' ? 0 : 0.28;
  h.api.helpers.production = () => ({ food: -0.41, stone: 0.56 });
  h.action('setJob', (id, total) => { h.state.jobs[id] = total; });

  h.autoJobs(h.api.getState(), {});

  assert.equal(h.state.jobs.forager, 4);
  assert.ok(h.calls.every(call => call[1] !== 'forager'));
});

test('queued stone cannot block food recovery or reclaim sustaining foragers', () => {
  const h = harness();
  h.state.pop = 47;
  h.state.jobs = { forager: 4, miner: 43, guard: 12 };
  h.state.res = { food: 0, stone: 3915 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 0.55 },
    miner: { res: 'stone', base: 1 },
  };
  h.api.helpers.capacityOf = () => 3915;
  h.api.helpers.jobProduction = id => id === 'forager' ? 0.55 : 1;
  h.api.helpers.production = () => ({ food: (h.state.jobs.forager - 4) * 0.55 - 0.41, stone: h.state.jobs.miner });
  h.action('setJob', (id, total) => { h.state.jobs[id] = total; });

  h.autoJobs(h.api.getState(), { stone: 2908 });
  assert.equal(h.state.jobs.forager, 5);
  assert.equal(h.state.jobs.miner, 42);
  for (let i = 0; i < 20; i++) h.autoJobs(h.api.getState(), { stone: 2908 });
  assert.ok(h.api.helpers.production().food > 0);
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

test('storage takes priority when queued resources cannot fit', () => {
  const h = harness();
  h.state.res = { wood: 50 };
  h.api.helpers.capacityOf = () => 50;
  h.state.queues = { build: [{ id: 'monument' }] };
  h.api.definitions.BUILDINGS = [
    { id: 'hut', max: 5, cost: { wood: 10 } },
    { id: 'storehouse', max: 5, cost: { wood: 10 } },
    { id: 'monument', max: 1, cost: { wood: 100 } },
  ];
  h.action('build', id => { h.state.bld[id] = (h.state.bld[id] || 0) + 1; });
  h.autoBuildings(h.api.getState(), { wood: 100 });
  assert.deepEqual(h.calls, [['build', 'storehouse']]);
});

test('an impossible queued stock keeps its reservation when no storage can help', () => {
  const h = harness();
  h.state.res = { wood: 50 };
  h.api.helpers.capacityOf = () => 50;
  h.api.definitions.BUILDINGS = [{ id: 'hut', max: 5, cost: { wood: 10 } }];
  h.action('build', id => { h.state.bld[id] = 1; });
  h.autoBuildings(h.api.getState(), { wood: 100 });
  assert.deepEqual(h.calls, []);
});

test('morale assignments do not skip research for the tick', () => {
  const h = harness();
  h.state.morale = 50;
  h.state.res.knowledge = 10;
  h.state.res.food = 100;
  h.api.definitions.JOBS = { performer: { targeted: true } };
  h.api.definitions.TECHS = [{ id: 'writing', cost: 10 }];
  h.action('assignPerformer', () => { h.state.jobs.performer = 1; });
  h.action('research', () => { h.state.techs.writing = true; });
  h.automationStep();
  assert.equal(h.state.techs.writing, true);
  assert.equal(h.state.jobs.performer, 1);
});

function moraleHarness() {
  const h = harness();
  h.state.pop = 53;
  h.state.morale = 0;
  h.state.res = { food: 3440, wood: 27, stone: 1609, knowledge: 79 };
  h.state.jobs = { forager: 5, woodcutter: 38, thinker: 4, miner: 4,
    performer: 1, explorer: 1 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 0.55 }, woodcutter: { res: 'wood', base: 0.45 },
    miner: { res: 'stone', base: 0.28 }, thinker: { res: 'knowledge', base: 0.12 },
    performer: { targeted: true }, explorer: { targeted: true },
  };
  h.api.helpers.jobProduction = id => h.api.definitions.JOBS[id]?.base || 0;
  h.api.helpers.production = () => ({ food: 4.21, wood: h.state.jobs.woodcutter * 0.45,
    stone: 0, knowledge: 1.52 });
  h.action('setJob', (id, count) => { h.state.jobs[id] = count; });
  h.action('assignPerformer', delta => {
    if (delta > 0 && h.availableWorkers(h.state) < 1) return false;
    h.state.jobs.performer += delta;
  });
  return h;
}

test('morale recruits a full recovery team without waiting for population growth', () => {
  const h = moraleHarness();
  h.autoMorale(h.api.getState());
  assert.equal(h.state.jobs.performer, 5);
  assert.equal(h.state.jobs.woodcutter, 34);
  assert.equal(h.state.jobs.forager, 5);
  assert.equal(h.state.jobs.thinker, 4);
  assert.equal(h.state.jobs.explorer, 1);
  assert.equal(h.availableWorkers(h.state), 0);
  const settledCalls = h.calls.length;
  for (const morale of [0, 70, 80, 100, 115, 135]) {
    h.state.morale = morale;
    h.autoMorale(h.api.getState());
  }
  assert.equal(h.calls.length, settledCalls);
});

test('morale uses idle villagers before donors and releases excess performers', () => {
  const h = moraleHarness();
  h.state.jobs.woodcutter -= 4;
  h.autoMorale(h.api.getState());
  assert.equal(h.state.jobs.performer, 5);
  assert.ok(h.calls.every(([name]) => name === 'assignPerformer'));
  h.state.jobs.performer += 3;
  h.state.jobs.woodcutter -= 3;
  h.autoMorale(h.api.getState());
  assert.equal(h.state.jobs.performer, 5);
  assert.equal(h.availableWorkers(h.state), 3);
});

test('morale preserves upkeep and gives food shortages priority', () => {
  const h = moraleHarness();
  h.api.helpers.production = () => ({ food: 1, wood: 0.45, stone: -1 });
  h.autoMorale(h.api.getState());
  assert.equal(h.state.jobs.performer, 2);
  assert.equal(h.state.jobs.woodcutter, 37);
  assert.equal(h.state.jobs.miner, 4);
  h.calls.length = 0;
  h.api.helpers.production = () => ({ food: -0.1, wood: 10 });
  h.autoMorale(h.api.getState());
  assert.deepEqual(h.calls, []);
  h.state.res.food = 0;
  h.api.helpers.production = () => ({ food: 1, wood: 10 });
  h.autoMorale(h.api.getState());
  assert.deepEqual(h.calls, []);
});

test('morale accounts for housing pressure and conquest, including Commonality', () => {
  const h = moraleHarness();
  h.state.bld.livingBlock = 2;
  h.state.tradePartners = ['human', 'rabbitfolk'];
  h.state.diplomacy.human = { conquered: true };
  h.autoMorale(h.api.getState());
  assert.equal(h.state.jobs.performer, 17);
  h.state.techs.commonality = true;
  h.state.policy = 'commonality';
  h.autoMorale(h.api.getState());
  assert.equal(h.state.jobs.performer, 7);
});

test('failed donor release does not overassign performers', () => {
  const h = moraleHarness();
  h.action('setJob', () => false);
  h.action('assign', () => false);
  h.autoMorale(h.api.getState());
  assert.equal(h.state.jobs.performer, 1);
  assert.ok(!h.calls.some(([name]) => name === 'assignPerformer'));
});

test('new research and buildings are discovered and obey unlocks and queues', () => {
  const h = harness();
  h.state.res = { knowledge: 500, wood: 100 };
  h.api.definitions.TECHS = [
    { id: 'futureScience', cost: 10, req: () => false },
    { id: 'advancedScience', cost: 50 },
    { id: 'futureTheory', cost: 20 },
  ];
  h.api.definitions.BUILDINGS = [
    { id: 'instrumentHall', cost: { wood: 10 }, req: () => !!h.state.techs.advancedScience },
    { id: 'futureLab', cost: { wood: 10 } },
  ];
  h.action('research', id => { h.state.techs[id] = true; });
  h.action('build', id => { h.state.queues.build = [{ id }]; });
  h.autoBuildings(h.api.getState(), {});
  assert.deepEqual(h.calls, [['build', 'futureLab']]);
  h.autoResearch(h.api.getState(), {});
  h.autoBuildings(h.api.getState(), {});
  h.autoResearch(h.api.getState(), {});
  assert.deepEqual(h.calls.slice(1), [
    ['research', 'advancedScience'], ['build', 'instrumentHall'], ['research', 'futureTheory'],
  ]);
});

test('new knowledge jobs fill dynamic caps and remain staffed until food emergencies', () => {
  for (const id of ['experimentalist', 'futureScholar']) {
    const h = harness();
    h.state.pop = 6;
    h.state.jobs = { forager: 2 };
    h.state.res = { food: 100, knowledge: 100 };
    h.api.definitions.JOBS = {
      forager: { res: 'food', base: 1 },
      [id]: { res: 'knowledge', base: 0.6, max: () => 2 },
      futureTarget: { res: 'knowledge', base: 1, targeted: true },
      futureLocked: { res: 'knowledge', base: 1, unlock: () => false },
      futureSupport: { base: 0 },
    };
    h.api.helpers.jobProduction = job => h.api.definitions.JOBS[job].base;
    h.api.helpers.production = () => ({ food: h.state.jobs.forager - 2, knowledge: (h.state.jobs[id] || 0) * 0.6 });
    h.action('setJob', (job, total) => { h.state.jobs[job] = total; });
    h.autoJobs(h.api.getState(), {});
    assert.equal(h.state.jobs[id], 2);
    h.autoJobs(h.api.getState(), {});
    assert.equal(h.state.jobs[id], 2);
    assert.ok(h.calls.every(call => ['forager', id].includes(call[1])));
    h.state.pop = 4;
    h.state.res.food = 0;
    h.api.helpers.production = () => ({ food: -1, knowledge: 1.2 });
    h.autoJobs(h.api.getState(), {});
    assert.equal(h.state.jobs[id], 0);
    assert.equal(h.state.jobs.forager, 4);
  }
});

test('unlocked tinkerer fills its limited capacity with dynamic production', () => {
  const h = harness();
  h.state.pop = 6;
  h.state.jobs = { forager: 1 };
  h.state.res = { food: 100, tools: 0 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    tinkerer: { res: 'tools', base: 0, max: 2, unlock: () => true },
  };
  h.api.helpers.jobProduction = id => id === 'tinkerer' ? 1 : 1;
  h.api.helpers.production = () => ({ food: 1, tools: 0 });
  h.action('setJob', (job, total) => { h.state.jobs[job] = total; });

  h.autoJobs(h.api.getState(), {});

  assert.equal(h.state.jobs.tinkerer, 2);
});

test('food deficit with a healthy stockpile does not block capped jobs', () => {
  const h = harness();
  h.state.pop = 8;
  h.state.jobs = { forager: 1, woodcutter: 7 };
  h.state.res = { food: 1975, wood: 194, tools: 0 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    woodcutter: { res: 'wood', base: 1 },
    tinkerer: { res: 'tools', base: 1, max: 2, unlock: () => true },
  };
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.production = () => ({ food: -1, wood: 26.3, tools: 0 });
  h.action('setJob', (job, total) => { h.state.jobs[job] = total; });

  h.autoJobs(h.api.getState(), {});

  assert.equal(h.state.jobs.tinkerer, 2);
});

test('tinkerer capacity preserves its woodcutter prerequisite', () => {
  const h = harness();
  h.state.pop = 27;
  h.state.jobs = { forager: 3, woodcutter: 23, tinkerer: 1 };
  h.state.res = { food: 1975, wood: 194, tools: 0 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    woodcutter: { res: 'wood', base: 1 },
    tinkerer: { res: 'tools', base: 1, max: () => 1 + Math.floor(h.state.jobs.woodcutter / 5), unlock: () => true },
  };
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.production = () => ({ food: 1, wood: 26.3, tools: 0 });
  h.action('setJob', (job, total) => { h.state.jobs[job] = total; });

  h.autoJobs(h.api.getState(), {});
  h.autoJobs(h.api.getState(), {});

  assert.equal(h.state.jobs.tinkerer, 5);
  assert.equal(h.state.jobs.woodcutter, 20);
});

test('filled finite jobs are not traded back and forth as donors', () => {
  const h = harness();
  h.state.pop = 8;
  h.state.jobs = { forager: 1, woodcutter: 3, copperminer: 2, banker: 2 };
  h.state.res = { food: 100, wood: 100, copper: 0, currency: 0 };
  h.api.definitions.JOBS = {
    forager: { res: 'food', base: 1 },
    woodcutter: { res: 'wood', base: 1 },
    copperminer: { res: 'copper', base: 1, max: 2 },
    banker: { res: 'currency', base: 1, max: 3 },
  };
  h.api.helpers.jobProduction = () => 1;
  h.api.helpers.production = () => ({ food: 1, wood: 1, copper: 0, currency: 0 });
  h.action('setJob', (job, total) => { h.state.jobs[job] = total; });

  h.autoJobs(h.api.getState(), {});
  h.autoJobs(h.api.getState(), {});

  assert.equal(h.state.jobs.copperminer, 2);
  assert.equal(h.state.jobs.banker, 3);
  assert.equal(h.state.jobs.woodcutter, 2);
});

test('boot works without an event subscription API', () => {
  const h = harness();
  h.context.document.getElementById = () => ({});
  h.context.setInterval = () => 1;
  assert.doesNotThrow(() => h.boot());
});
