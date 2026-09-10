// ==UserScript==
// @name         Emberhold Automation
// @namespace    https://github.com/emberhold
// @version      1.30.19
// @description  Configurable automation for Emberhold
// @updateURL    https://raw.githubusercontent.com/Nuku/Emberhold-Automation/main/emberhold_automation.user.js
// @downloadURL  https://raw.githubusercontent.com/Nuku/Emberhold-Automation/main/emberhold_automation.user.js
// @match        https://nuku.github.io/Emberhold/*
// @match        file:///*
// @match        http://localhost:*/*
// @match        http://127.0.0.1:*/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const SETTINGS_KEY = 'emberhold_automation_settings';
  const DEFAULTS = {
    enabled: true,
    jobs: true,
    research: true,
    buildings: true,
    power: true,
    crafting: true,
    diplomacy: true,
    combat: false,
    expeditions: true,
    wonderStart: false,
    wonderHandle: false,
    interval: 1000,
  };

  let settings = loadSettings();
  let timer = null;
  let busy = false;
  let lastAction = 'Waiting for Emberhold';
  const pausedDiplomats = Object.create(null);

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function api() {
    return window.emberhold;
  }

  function snapshot() {
    return api()?.getState?.();
  }

  function definitions() {
    return api()?.definitions || {};
  }

  function invoke(name, ...args) {
    if (!settings.enabled) return false;
    const action = api()?.actions?.[name] || (api()?.action ? (...values) => api().action(name, ...values) : null);
    if (!action) {
      lastAction = `No action API (${name})`;
      return false;
    }
    try {
      const before = JSON.stringify(snapshot());
      const result = action(...args);
      if (result === false || JSON.stringify(snapshot()) === before) {
        lastAction = `No change: ${name}`;
        return false;
      }
    } catch (error) {
      lastAction = `Error in ${name}: ${error?.message || error}`;
      console.error('[Emberhold Automation]', lastAction, error);
      return false;
    }
    lastAction = `${name}${args.length ? ` (${args.join(', ')})` : ''}`;
    return true;
  }

  function affordable(cost, state, demand = {}) {
    return Object.entries(cost || {}).every(([id, amount]) =>
      Math.max(0, (state.res[id] || 0) - (demand[id] || 0)) >= amount);
  }

  function researchCost(def) {
    const cost = api().helpers?.researchCost?.(def) ?? def?.cost;
    return typeof cost === 'number' ? { knowledge: cost } : (cost || {});
  }

  function queuedDemand(state = snapshot()) {
    if (!state?.settings?.strictQueueOrder) return api().helpers?.queueDemand?.() || {};

    // In strict mode the game only considers the first entry in each queue.
    // Do not reserve resources for later entries: doing so can prevent the
    // active entry from ever becoming affordable.
    const demand = {};
    const definitionsByType = {
      build: definitions().BUILDINGS || [],
      research: definitions().TECHS || [],
      expedition: definitions().EXPEDITIONS || [],
    };
    for (const type of Object.keys(definitionsByType)) {
      const entry = state.queues?.[type]?.[0];
      if (!entry) continue;
      const def = definitionsByType[type].find(item => item.id === entry.id);
      const cost = type === 'build'
        ? (def && (api().helpers?.buildingCost?.(def) || def.cost)) || entry.cost
        : type === 'research'
          ? (def ? researchCost(def) : entry.cost)
          : (def && (api().helpers?.expeditionCost?.(def) || def.cost)) || entry.cost;
      for (const [resource, amount] of Object.entries(cost || {})) {
        demand[resource] = (demand[resource] || 0) + amount;
      }
    }
    return demand;
  }

  function unlocked(def, state) {
    try {
      return !def.req || def.req();
    } catch (_) {
      return false;
    }
  }

  function jobUnlocked(def) {
    try {
      return !def.unlock || def.unlock();
    } catch (_) {
      return false;
    }
  }

  function availableWorkers(state) {
    if (typeof api().helpers?.unassigned === 'function') {
      return Math.max(0, api().helpers.unassigned());
    }
    const assigned = Object.entries(state.jobs || {})
      .filter(([id]) => id !== 'guard')
      .reduce((sum, [, n]) => sum + (Number(n) || 0), 0);
    const diplomats = Object.values(state.diplomats || {})
      .reduce((sum, n) => sum + (Number(n) || 0), 0);
    return Math.max(0, state.pop - assigned - diplomats);
  }

  function jobCount(id) {
    return Number(snapshot()?.jobs?.[id] || 0);
  }

  function assignWorkers(id, amount, state) {
    const count = Number(state.jobs?.[id] || 0);
    const requested = Math.max(0, Math.floor(Number(amount) || 0));
    if (!requested) return false;

    // Current builds expose setJob, while older builds expose assign(job, delta).
    // Do not trust the presence of setJob alone: some game versions expose the
    // name but reject a bulk update when the requested count exceeds capacity.
    if (api().actions?.setJob) {
      const expected = count + requested;
      if (invoke('setJob', id, expected) && jobCount(id) >= expected) return true;
    }

    const remaining = Math.max(0, count + requested - jobCount(id));
    let changed = false;
    for (let i = 0; i < remaining; i++) {
      if (!invoke('assign', id, 1)) break;
      changed = true;
    }
    return changed;
  }

  function releaseWorkers(id, amount) {
    const current = jobCount(id);
    const requested = Math.max(0, Math.floor(Number(amount) || 0));
    if (!requested) return false;
    const expected = Math.max(0, current - requested);

    // Some builds expose setJob but partially apply a bulk decrease. Verify
    // the resulting count and finish the release through the delta API.
    if (api().actions?.setJob && invoke('setJob', id, expected) && jobCount(id) <= expected) {
      return true;
    }

    let changed = false;
    const remaining = Math.max(0, jobCount(id) - expected);
    for (let i = 0; i < remaining; i++) {
      if (!invoke('assign', id, -1)) break;
      changed = true;
    }
    return changed;
  }

  function craftable(def, state) {
    if (!unlocked(def, state)) return false;
    if (def.id === 'tools' && state.trial?.id === 'tinkering') return false;
    const capacityOf = api().helpers?.capacityOf;
    return !capacityOf || Object.keys(def.give || {}).every(id =>
      (state.res[id] || 0) < capacityOf(id));
  }

  // Preferred order, not an allowlist: new definitions remain eligible.
  function orderedIds(preferred, ids) {
    return [...new Set([...preferred.filter(id => ids.includes(id)), ...ids])];
  }
  const RESEARCH_ORDER = [
    'stoneWorking', 'writing', 'craftsmanship', 'masonry', 'copperProspecting',
    'currency', 'guards', 'leatherArmor', 'deepMining', 'seamMining',
    'metallurgy', 'weaponry', 'banking', 'diplomacy', 'civics', 'council',
    'machineryTech', 'hydraulics', 'weaponEfficiency', 'electricalEngineering',
    'advancedScience', 'astronomy', 'optics', 'aphrodisiac', 'hospital',
  ];
  const BUILD_ORDER = [
    'hut', 'storehouse', 'foragerLodge', 'lumberYard', 'quarry', 'stoneWorks',
    'workbench', 'library', 'monument', 'barracks', 'trainingYard', 'hospital', 'deepMine', 'deepStore',
    'coalSeam', 'forge', 'aqueduct', 'shrine', 'amphitheatre', 'workshop',
    'steamPlant', 'dynamo', 'vault', 'factory', 'instrumentHall', 'observatory', 'beacon',
  ];
  const STORAGE_BUILDINGS = new Set(['storehouse', 'deepStore', 'vault']);
  const JOB_ORDER = [
    'forager', 'woodcutter', 'miner', 'thinker', 'experimentalist', 'tinkerer', 'digger',
    'ironminer', 'copperminer', 'astronomer', 'banker', 'diplomat',
  ];
  // Current game builds export FACTORY_RECIPES. Keep the current public
  // recipes as a compatibility fallback for older builds.
  const FACTORY_RECIPES = [
    { id: 'goods', inputs: {} },
    { id: 'tools', inputs: { wood: 3.2 }, tech: 'craftsmanship' },
    { id: 'steel', inputs: { iron: 0.6, coal: 0.4 }, tech: 'metallurgy' },
    { id: 'machinery', inputs: { steel: 0.1, coal: 0.4 }, tech: 'machineryTech' },
  ];
  const FACTORY_TRIAL_GOALS = { industrialization: { resource: 'goods', amount: 100 },
    silence: { resource: 'steel', amount: 100 } };
  const COMBAT_STAGES = [
    { id: 'raid', cost: { food: 30, tools: 2 } },
    { id: 'foray', cost: { food: 40, tools: 2 } },
    { id: 'skirmish', cost: { food: 50, tools: 3 } },
    { id: 'assault', cost: { food: 65, tools: 3 } },
    { id: 'offensive', cost: { food: 80, tools: 4 } },
    { id: 'breakthrough', cost: { food: 100, tools: 5 } },
    { id: 'breach', cost: { food: 125, tools: 6 } },
  ];

  function factoryRecipes() {
    const exposed = definitions().FACTORY_RECIPES;
    return Array.isArray(exposed) && exposed.length ? exposed : FACTORY_RECIPES;
  }

  function currentFactoryRecipe(state) {
    const current = state.factoryRecipe || api().helpers?.factoryRecipe?.()?.id;
    return factoryRecipes().find(recipe => recipe.id === current) || factoryRecipes()[0];
  }

  function factoryRecipeUnlocked(recipe, state) {
    return !!recipe && (!recipe.tech || state.techs?.[recipe.tech]);
  }

  function autoFactory(state, demand) {
    if (!(state.bld?.factory > 0) ||
        !(api().actions?.chooseFactoryRecipe || api().action)) return;
    const recipes = factoryRecipes().filter(recipe => factoryRecipeUnlocked(recipe, state));
    const byOutput = new Map(recipes.map(recipe => [recipe.id, recipe]));
    const stock = resource => Math.max(0, Number(state.res?.[resource] || 0));
    const goals = recipes.filter(recipe => (demand[recipe.id] || 0) > stock(recipe.id));
    const trialGoal = FACTORY_TRIAL_GOALS[state.trial?.id];
    if (trialGoal && stock(trialGoal.resource) < trialGoal.amount) {
      const recipe = byOutput.get(trialGoal.resource);
      if (recipe && !goals.includes(recipe)) goals.push(recipe);
    }
    if (!goals.length) return;

    // A Factory has one shared line. When the requested output consumes a
    // factory-made component (Machinery -> Steel), make a small input buffer
    // first so switching to the final line produces immediately.
    const factoryCount = Math.max(1, Number(state.bld.factory || 0));
    const inputRecipe = (recipe, seen = new Set()) => {
      if (seen.has(recipe.id)) return null;
      const nextSeen = new Set(seen).add(recipe.id);
      for (const [input, rate] of Object.entries(recipe.inputs || {})) {
        const producer = byOutput.get(input);
        if (!producer) continue;
        const buffer = Math.max(Number(rate) || 0, (Number(rate) || 0) * factoryCount * 10);
        if (stock(input) < buffer) return inputRecipe(producer, nextSeen) || producer;
      }
      return null;
    };
    const target = inputRecipe(goals[0]) || goals[0];
    if (currentFactoryRecipe(state)?.id !== target.id) invoke('chooseFactoryRecipe', target.id);
  }

  function autoMorale(state) {
    const defs = definitions().JOBS || {};
    const performer = defs.performer;
    if (!performer || !jobUnlocked(performer)) return false;
    const performers = Number(state.jobs?.performer || 0);
    const rawRates = api().helpers?.production?.(1) || {};
    const rates = Object.fromEntries(Object.entries(rawRates)
      .map(([resource, rate]) => [resource, Number(rate)]));
    // Let the food planner use idle villagers and surplus producers first.
    if (rates.food < 0 || (state.res.food || 0) <= 0.0001) return false;

    const partners = Array.isArray(state.tradePartners)
      ? (state.tradePartner && state.tradePartners[0] !== state.tradePartner
        ? [state.tradePartner] : state.tradePartners)
      : [state.tradePartner];
    const commonality = state.techs?.commonality && state.policy === 'commonality';
    const conquered = commonality ? 0 : [...new Set(partners)]
      .filter(id => id && state.diplomacy?.[id]?.conquered).length;
    // The API does not expose morale drift. Budget for storms (-.060), winter
    // (-.006), and secure food at high morale (-.008), plus .025/s recovery.
    // Do not rely on Shrine/Hospital bonuses that disappear as morale rises.
    // Keeping this target at the ceiling avoids repeated hiring and firing.
    const pressure = Math.max(0, state.pop - 20) * 0.01 +
      Number(state.bld?.livingBlock || 0) * 0.1 + conquered;
    const target = Math.ceil((pressure + 0.060 + 0.006 + 0.008 + 0.025) / 0.10);
    if (performers > target) {
      for (let i = performers; i > target; i--) {
        if (!invoke('assignPerformer', -1)) break;
      }
      return jobCount('performer') < performers;
    }
    if (performers >= target) return false;

    let missing = Math.max(0, target - performers - availableWorkers(state));
    const donors = Object.keys(state.jobs || {}).filter(id => id !== 'guard' &&
      id !== 'performer' && !defs[id]?.targeted && defs[id]?.res &&
      !['food', 'knowledge'].includes(defs[id].res))
      .sort((a, b) => Number(state.jobs[b]) - Number(state.jobs[a]));
    for (const id of donors) {
      if (missing <= 0) break;
      const count = jobCount(id);
      const rate = api().helpers?.jobProduction?.(id);
      const net = rates[defs[id].res];
      // Preserve one worker and enough output to cover ongoing consumption.
      const surplus = rate > 0 && Number.isFinite(net)
        ? Math.max(0, Math.min(count - 1, Math.floor((net + 1e-9) / rate))) : 0;
      if (!surplus) continue;
      releaseWorkers(id, Math.min(surplus, missing));
      const released = count - jobCount(id);
      missing -= released;
      rates[defs[id].res] -= released * rate;
    }
    const additions = Math.min(target - performers, availableWorkers(snapshot()));
    for (let i = 0; i < additions; i++) {
      if (!invoke('assignPerformer', 1)) break;
    }
    return jobCount('performer') > performers;
  }

  function autoJobs(state, demand) {
    const defs = definitions().JOBS || {};
    const effectiveJobRate = api().helpers?.jobProduction;
    const jobOrder = orderedIds(JOB_ORDER, Object.keys(defs));
    const knowledgeWorker = id => defs[id]?.res === 'knowledge';
    const productive = id => effectiveJobRate
      ? Number(effectiveJobRate(id)) > 0
      : Number(defs[id].base) > 0;
    const assignable = jobOrder.filter(id => id !== 'guard' && !defs[id].targeted &&
      defs[id].res && jobUnlocked(defs[id]) && productive(id));

    const count = id => Number(state.jobs?.[id] || 0);
    const stock = id => Math.max(0, (state.res[id] || 0) - (demand[id] || 0));
    const minimums = [
      ['forager', 1],
      ['woodcutter', 1],
      ['miner', state.pop >= 6 ? 1 : 0],
      ['thinker', state.pop >= 8 ? 1 : 0],
    ];
    const rawRates = api().helpers?.production?.(1) || {};
    const rates = Object.fromEntries(Object.entries(rawRates)
      .map(([resource, rate]) => [resource, Number(rate)]));
    // production() already includes all upkeep. Feed the village before queue
    // reserves or diplomacy: a demanded job must still be able to donate.
    const foodRate = Number.isFinite(rates.food) ? rates.food : 0;
    const foodWorkerRate = Number(effectiveJobRate?.('forager') ?? defs.forager?.base ?? 0);
    const foodBuffer = (state.res.food || 0) <= 0 ? foodWorkerRate * 0.25 : 0;
    if (assignable.includes('forager') && foodWorkerRate > 0 &&
        stock('food') <= 0 && foodRate < foodBuffer) {
      const required = Math.ceil((foodBuffer - foodRate) / foodWorkerRate);
      let missing = Math.max(0, required - availableWorkers(state));
      const donors = Object.keys(state.jobs || {}).filter(id => id !== 'forager' &&
        id !== 'guard' && defs[id] && !defs[id].targeted && count(id) > 0)
        .sort((a, b) => count(b) - count(a));
      for (const id of donors) {
        if (missing <= 0) break;
        const before = jobCount(id);
        releaseWorkers(id, Math.min(before, missing));
        missing -= before - jobCount(id);
      }
      const current = snapshot();
      assignWorkers('forager', Math.min(required, availableWorkers(current)), current);
      return;
    }
    const currencyTarget = Math.max(100, Math.ceil((demand.currency || 0) * 0.10));
    const capacityOf = api().helpers?.capacityOf;
    const reserve = resource => {
      if (resource === 'knowledge' || resource === 'currency') return 100;
      const cap = typeof capacityOf === 'function' ? capacityOf(resource) : Infinity;
      return Number.isFinite(cap) ? Math.max(10, Math.ceil(cap * 0.5)) : 10;
    };
    const needsWork = id => {
      const resource = defs[id]?.res;
      if (!resource) return true;
      if (resource === 'currency') return stock('currency') < currencyTarget || (rates.currency || 0) < 0;
      return stock(resource) < reserve(resource) || (demand[resource] || 0) > 0 || (rates[resource] || 0) < 0;
    };
    // Coal consumption can be input-limited by Iron (Forges) or by the
    // current fuel state (Steam Plants). That makes the one-second net rate
    // alternate between positive and negative while the coal store is low.
    // Protect existing Coal Diggers below a high-water mark and let the
    // normal capacity planning refill any missing diggers.
    const coalIndustry = Number(state.bld?.forge || 0) > 0 ||
      Number(state.bld?.steamPlant || 0) > 0;
    const coalHighWater = typeof capacityOf === 'function'
      ? Math.ceil(capacityOf('coal') * 0.75) : Infinity;
    const coalReserveActive = id => id === 'digger' && coalIndustry &&
      Number(state.res?.coal || 0) < coalHighWater;
    // Keep the workers whose output offsets consumption. A positive net rate
    // with the current workforce does not mean the whole workforce is surplus.
    const sustainingMinimum = id => {
      const resource = defs[id]?.res;
      // Older game builds may not expose jobProduction(). The job definition
      // still contains the base output rate, so do not conservatively pin all
      // food workers in place when the live helper is unavailable.
      const perWorker = Number(effectiveJobRate?.(id) ?? defs[id]?.base ?? 0);
      if (!(perWorker > 0) || !Number.isFinite(rates[resource])) {
        return id === 'forager' ? count(id) : 0;
      }
      return Math.max(0, Math.min(count(id),
        Math.ceil(count(id) - rates[resource] / perWorker - 1e-9)));
    };
    const minimum = id => Math.max(sustainingMinimum(id), coalReserveActive(id) ? count(id) :
      id === 'forager' ? 1 :
      (!needsWork(id) || (effectiveJobRate && effectiveJobRate(id) <= 0)
        ? 0 : minimums.find(item => item[0] === id)?.[1] || 0));
    const needs = [
      ['forager', 'food', reserve('food')],
      ['woodcutter', 'wood', reserve('wood')],
      ['miner', 'stone', reserve('stone')],
      ['thinker', 'knowledge', reserve('knowledge')],
    ];
    const specialistNeeds = assignable
      .filter(id => defs[id].res && Number(defs[id].base) > 0 &&
        !needs.some(([job]) => job === id))
      .map(id => [id, defs[id].res, reserve(defs[id].res)]);
    const demandNeeds = assignable
      .filter(id => defs[id].res && Number(defs[id].base) > 0 && (demand[defs[id].res] || 0) > 0)
      .map(id => [id, defs[id].res,
        Math.max(reserve(defs[id].res), Math.ceil((demand[defs[id].res] || 0) * 0.10))]);
    if (settings.diplomacy && defs.diplomat && jobUnlocked(defs.diplomat) &&
        (api()?.actions?.assignDiplomat || api()?.action)) {
      for (const [id, count] of Object.entries(state.diplomats || {})) {
        if (count > 0 && state.diplomacy?.[id]?.disposition >= 100) {
          if (invoke('assignDiplomat', id, -1)) {
            pausedDiplomats[id] = (pausedDiplomats[id] || 0) + 1;
            return;
          }
        }
      }

      const available = availableWorkers(state);
      if (available > 0) {
        for (const [id, count] of Object.entries(pausedDiplomats)) {
          if (count > 0 && state.diplomacy?.[id]?.disposition < 100) {
            if (invoke('assignDiplomat', id, 1)) {
              pausedDiplomats[id] = count - 1;
              return;
            }
          }
        }
      }
    }
    // Explorers are targeted workers, so ordinary production planning must
    // never retask them. Give exploration its initial worker whenever one is
    // idle, though, or it can never begin on its own.
    if (defs.explorer && jobUnlocked(defs.explorer) && count('explorer') < 1 &&
        availableWorkers(state) > 0) {
      invoke('assignExplorer', 1);
      return;
    }
    if (!assignable.length) return;

    const available = availableWorkers(state);
    const perWorker = id => Math.max(0, Number(effectiveJobRate?.(id) || defs[id]?.base || 0));
    // An empty food store is an emergency. A negative rate still raises food
    // staffing through needs/shortage planning, but should not block finite
    // capacity jobs while the stockpile has room to recover.
    const foodEmergency = stock('food') <= 0;
    // Tinkerer capacity is tied to the woodcutter count. Preserve the
    // woodcutters needed for the capacity we are trying to fill, otherwise
    // staffing Tinkerers lowers their cap and causes a one-tick oscillation.
    const tinkererWoodMinimum = () => {
      if (!defs.tinkerer || !Number.isFinite(jobLimit('tinkerer'))) return 0;
      const target = Math.max(count('tinkerer'), jobLimit('tinkerer'));
      return Math.max(0, (target - 1) * 5);
    };
    const donorMinimum = id => {
      const cappedJobNeedsWorkers = assignable.some(job => {
        const limit = jobLimit(job);
        return Number.isFinite(limit) && count(job) < limit;
      });
      const woodIsStocked = id === 'woodcutter' &&
        stock('wood') >= reserve('wood') && !(demand.wood || 0) &&
        (rates.wood || 0) >= 0 && cappedJobNeedsWorkers;
      // A positive wood stockpile means the net-production floor is not a
      // useful donor constraint. Keep the ordinary one-worker floor, then
      // apply the separate Woodcutter prerequisite for Tinkerers below.
      const sustainingFloor = woodIsStocked
        ? (minimums.find(item => item[0] === id)?.[1] || 0)
        : minimum(id);
      const baseMinimum = coalReserveActive(id) ? minimum(id) :
        (foodEmergency && id !== 'forager' ? 0 : sustainingFloor);
      const limit = jobLimit(id);
      const finiteSeatMinimum = !foodEmergency && Number.isFinite(limit) ? count(id) : 0;
      const prerequisiteMinimum = id === 'woodcutter' ? tinkererWoodMinimum() : 0;
      return Math.max(baseMinimum, finiteSeatMinimum, prerequisiteMinimum);
    };
    // Limited jobs get first claim on non-emergency population. This keeps
    // jobs such as miners and thinkers full even when a queue is requesting a
    // different resource. Food emergencies deliberately skip this fill so the
    // last available worker can be sent to the farms instead.
    const jobCapacity = api().helpers?.jobCapacity;
    const jobLimit = id => {
      const reported = typeof jobCapacity === 'function' ? Number(jobCapacity(id)) : NaN;
      if (Number.isFinite(reported)) return reported;
      for (const field of ['max', 'limit']) {
        const value = defs[id]?.[field];
        if (value == null) continue;
        try {
          const limit = Number(typeof value === 'function' ? value() : value);
          if (Number.isFinite(limit)) return Math.max(0, Math.floor(limit));
        } catch (_) { /* An unavailable legacy limit must not stop other jobs. */ }
      }
      return NaN;
    };
    const neededWorkers = (id, resource, target) => {
      const rate = perWorker(id);
      if (!rate) return 0;
      const deficit = Math.max(0, target - stock(resource));
      const currentRate = resource === 'food' ? foodRate : (rates[resource] || 0);
      const shortage = Math.max(0, -currentRate);
      return Math.max(deficit ? Math.ceil(deficit / rate) : 0,
        shortage ? Math.ceil(shortage / rate) : 0);
    };
    const availableJobRoom = id => {
      const limit = jobLimit(id);
      return Number.isFinite(limit) ? Math.max(0, limit - count(id)) : Infinity;
    };
    const plannedAmount = (id, amount) => Math.min(amount, availableJobRoom(id));
    const planned = new Map();
    if (!foodEmergency) {
      for (const id of assignable) {
        const limit = jobLimit(id);
        if (Number.isFinite(limit) && limit < state.pop && count(id) < limit) {
          planned.set(id, limit - count(id));
        }
      }
    }
    for (const [id, resource, target] of [...demandNeeds, ...needs, ...specialistNeeds]) {
      if (!assignable.includes(id)) continue;
      if (foodEmergency && knowledgeWorker(id)) continue;
      const amount = plannedAmount(id, neededWorkers(id, resource, target));
      if (amount) planned.set(id, Math.max(planned.get(id) || 0, amount));
    }
    for (const [id, minimumCount] of minimums) {
      if (minimumCount > 0 && assignable.includes(id) && count(id) < minimum(id)) {
        const amount = plannedAmount(id, minimum(id) - count(id));
        if (amount) planned.set(id, Math.max(planned.get(id) || 0, amount));
      }
    }

    const donors = Object.keys(state.jobs || {})
      .filter(id => defs[id] && !defs[id].targeted && id !== 'guard' &&
        (!knowledgeWorker(id) || foodEmergency) && count(id) > donorMinimum(id))
      .sort((a, b) => count(b) - donorMinimum(b) - (count(a) - donorMinimum(a)));
    const releases = new Map();
    let needed = Math.max(0, [...planned].reduce((sum, [, amount]) => sum + amount, 0) - available);
    for (const donor of donors) {
      if (needed <= 0) break;
      const release = Math.min(needed, count(donor) - donorMinimum(donor));
      if (release) releases.set(donor, release);
      needed -= release;
    }

    let free = available + [...releases.values()].reduce((sum, amount) => sum + amount, 0);
    const additions = new Map();
    for (const [id, amount] of planned) {
      const add = Math.min(amount, free);
      if (add) additions.set(id, add);
      free -= add;
    }

    for (const [id, amount] of releases) {
      const targetCount = Math.max(donorMinimum(id), count(id) - amount);
      releaseWorkers(id, Math.max(0, count(id) - targetCount));
    }
    for (const [id, amount] of additions) assignWorkers(id, amount, state);
    const remainingWorkers = availableWorkers(snapshot());
    let filledFallback = false;
    if (remainingWorkers > 0) {
      const fallback = assignable
        .filter(id => {
          const limit = jobLimit(id);
          return (!Number.isFinite(limit) || jobCount(id) < limit) &&
            (id !== 'forager' || !assignable.some(other => other !== 'forager' &&
              (!Number.isFinite(jobLimit(other)) || jobCount(other) < jobLimit(other))));
        })
        .sort((a, b) => Number(Number.isFinite(jobLimit(b)) && jobLimit(b) < state.pop) -
          Number(Number.isFinite(jobLimit(a)) && jobLimit(a) < state.pop) ||
          Number(needsWork(b)) - Number(needsWork(a)) ||
          jobOrder.indexOf(a) - jobOrder.indexOf(b))[0];
      if (fallback) {
        const limit = jobLimit(fallback);
        const room = Number.isFinite(limit) ? Math.max(0, limit - jobCount(fallback)) : remainingWorkers;
        const before = jobCount(fallback);
        assignWorkers(fallback, Math.min(remainingWorkers, room), snapshot());
        filledFallback = jobCount(fallback) > before;
      }
    }
    if (!filledFallback) {
      // Do not keep surplus foragers assigned just because another job has a
      // plan. Leave those villagers idle for the next automation pass, which
      // can assign them to the next urgent job.
      const foragers = jobCount('forager');
      const minimumForagers = donorMinimum('forager');
      const surplusForagers = Math.max(0, foragers - minimumForagers);
      if (surplusForagers) releaseWorkers('forager', surplusForagers);
    }
  }

  function autoResearch(state, demand) {
    const defs = definitions().TECHS || [];
    for (const id of orderedIds(RESEARCH_ORDER, defs.map(def => def.id))) {
      if (state.queues?.research?.some(entry => entry.id === id)) continue;
      const def = defs.find(item => item.id === id);
      if (def && !state.techs[id] && unlocked(def, state) &&
          affordable(researchCost(def), state, demand)) {
        if (invoke('research', id)) return;
      }
    }
  }

  // Keep the legacy reserve for older API snapshots. Newer snapshots expose
  // factories and Living Blocks as controllable power buildings themselves.
  const FACTORY_POWER_REQUIREMENT = 1.5;

  function autoPower(state, demand) {
    const power = state.power || api().getPower?.();
    if (!power || !Number.isFinite(power.generated) || !Number.isFinite(power.used) ||
        !power.buildings || !(api().actions?.setBuildingPower || api().action)) return;
    const sites = Object.entries(power.buildings);
    if (sites.some(([, site]) => !['built', 'enabled', 'used', 'powerPerBuilding']
      .every(key => Number.isFinite(site[key])) || site.powerPerBuilding <= 0)) return;
    const hasAllControls = sites.some(([id]) => id === 'factory') &&
      sites.some(([id]) => id === 'livingBlock');
    const optionalUsed = sites.reduce((sum, [, site]) => sum + site.used, 0);
    let budget = hasAllControls
      ? Math.max(0, power.generated)
      : Math.max(0, power.generated - Math.max(0, power.used - optionalUsed) -
        (state.bld.factory || 0) * FACTORY_POWER_REQUIREMENT);
    const rates = api().helpers?.production?.(1) || {};
    const jobs = definitions().JOBS || {};
    const priority = site => {
      const resource = site.resource;
      if (site.id === 'livingBlock') return 4;
      // Queue reservations are the next priority after residential capacity.
      // Factories produce their selected recipe, while dig sites produce their
      // reported resource.
      const output = site.id === 'factory' ? currentFactoryRecipe(state)?.id || 'goods' : resource;
      if ((demand[output] || 0) > 0) return 3;
      if (site.id === 'factory') return 1;
      const stock = state.res[resource] || 0;
      // Compare the rate without this site's boost, so powering a shortage
      // does not immediately demote it on the next automation tick.
      let baseline = rates[resource] || 0;
      if (site.productionBonus > 0 && api().helpers?.jobProduction) {
        for (const [id, job] of Object.entries(jobs)) {
          if (job.res === resource && !job.targeted) baseline -=
            (state.jobs[id] || 0) * api().helpers.jobProduction(id) *
            site.productionBonus / (1 + site.productionBonus);
        }
      }
      if (baseline < -1e-9) return 3;
      if ((demand[resource] || 0) > stock) return 2;
      const capacity = api().helpers?.capacityOf?.(resource);
      return !Number.isFinite(capacity) || stock < capacity ? 1 : 0;
    };
    const ranked = sites.map(([id, site]) => ({ id, site: { ...site, id }, priority: priority({ ...site, id }) }))
      .sort((a, b) => b.priority - a.priority ||
        Number(b.site.resource === 'coal') - Number(a.site.resource === 'coal') ||
        a.id.localeCompare(b.id));
    const targets = ranked.map(({ id, site, priority }) => {
      const count = priority ? Math.min(Math.floor(site.built),
        Math.floor((budget + 1e-9) / site.powerPerBuilding)) : 0;
      budget = Math.max(0, budget - count * site.powerPerBuilding);
      return { id, count, enabled: site.enabled };
    });
    // Shed loads first. Stop on failure rather than enabling against capacity
    // that the game did not actually release.
    for (const target of targets.filter(t => t.count < t.enabled)
      .concat(targets.filter(t => t.count > t.enabled))) {
      if (!invoke('setBuildingPower', target.id, target.count)) return;
      const current = snapshot();
      const actual = (current.power || api().getPower?.())?.buildings?.[target.id]?.enabled;
      if (actual !== target.count) return;
    }
  }

  function autoBuildings(state, demand) {
    const defs = definitions().BUILDINGS || [];
    const capacityOf = api().helpers?.capacityOf;
    const queueNeedsMoreRoom = typeof capacityOf === 'function' &&
      Object.entries(demand || {}).some(([resource, amount]) => {
        const capacity = capacityOf(resource);
        return Number.isFinite(capacity) && amount > capacity;
      });

    // A queued project whose required stock cannot fit is permanently stuck.
    // Let storage consume its reserved materials: it is the one exception to
    // ordinary queue reservations because it makes those reservations feasible.
    if (queueNeedsMoreRoom) {
      for (const id of orderedIds(BUILD_ORDER, defs.map(def => def.id))) {
        if (!STORAGE_BUILDINGS.has(id) || state.queues?.build?.some(entry => entry.id === id)) continue;
        const def = defs.find(item => item.id === id);
        if (!def || state.bld[id] >= def.max || !unlocked(def, state)) continue;
        const canBuild = api().helpers?.canBuild;
        if (canBuild ? !canBuild(id) : state.trial?.id === 'overflow') continue;
        const cost = typeof api().helpers?.buildingCost === 'function'
          ? api().helpers.buildingCost(def) : def.cost;
        if (settings.crafting && craftMissingFor(cost, state, {})) return;
        if (affordable(cost, state, {}) && invoke('build', id)) return;

        // Do not spend the scarce stock on unrelated construction while an
        // available storage building is the only path to completing the queue.
        return;
      }
    }
    for (const id of orderedIds(BUILD_ORDER, defs.map(def => def.id))) {
      if (state.queues?.build?.some(entry => entry.id === id)) continue;
      const def = defs.find(item => item.id === id);
      if (!def || state.bld[id] >= def.max || !unlocked(def, state)) continue;
      const canBuild = api().helpers?.canBuild;
      if (canBuild ? !canBuild(id) :
        (state.trial?.id === 'overflow' && ['storehouse', 'deepStore', 'vault'].includes(id))) continue;
      const cost = typeof api().helpers?.buildingCost === 'function'
        ? api().helpers.buildingCost(def) : def.cost;
      if (settings.crafting && craftMissingFor(cost, state, demand)) return;
      if (affordable(cost, state, demand)) {
        if (invoke('build', id)) return;
      }
    }
  }

  function craftMissingFor(cost, state, demand, seen = new Set()) {
    const defs = definitions().CRAFTS || [];
    for (const [resource, amount] of Object.entries(cost || {})) {
      if (Math.max(0, (state.res[resource] || 0) - (demand[resource] || 0)) >= amount) continue;
      const recipe = defs.find(def => def.give?.[resource] && craftable(def, state));
      if (!recipe || seen.has(recipe.id)) continue;
      const nextSeen = new Set(seen).add(recipe.id);
      const missingInput = Object.entries(recipe.cost || {})
        .find(([input, inputAmount]) => Math.max(0, (state.res[input] || 0) - (demand[input] || 0)) < inputAmount);
      if (missingInput && craftMissingFor({ [missingInput[0]]: missingInput[1] }, state, demand, nextSeen)) return true;
      if (!missingInput && affordable(recipe.cost, state, demand)) {
        if (invoke('craft', recipe.id)) return true;
      }
    }
    return false;
  }

  function autoCraft(state, demand) {
    // Supply queued projects before stocking a single batch of each recipe.
    // Their desired outputs are already included in demand; do not subtract
    // them again when checking whether the queued output is covered.
    for (const [resource, amount] of Object.entries(demand)) {
      const inputDemand = { ...demand, [resource]: 0 };
      if (craftMissingFor({ [resource]: amount }, state, inputDemand)) return;
    }
    const defs = definitions().CRAFTS || [];
    const target = defs.find(def => craftable(def, state) && affordable(def.cost, state, demand) &&
      Object.entries(def.give || {}).some(([id, amount]) =>
        (state.res[id] || 0) < amount));
    if (target) invoke('craft', target.id);
  }

  function autoDiplomacy(state, demand) {
    for (const [id, entry] of Object.entries(state.diplomacy || {})) {
      if (settings.combat && (entry.hostile === true || Number(entry.disposition) < 0)) continue;
      const request = entry.request;
      if (entry.disposition >= 100) continue;
      if (request && affordable({ [request.res]: request.amount }, state, demand)) {
        const previousAction = lastAction;
        if (invoke('supplyDiplomacyRequest', id)) return;
        // A stale or already-satisfied request must not mask other automation
        // stages with a permanent "No change" status.
        lastAction = previousAction;
      }
    }
  }

  function autoExpeditions(state, demand) {
    const defs = definitions().EXPEDITIONS || [];
    for (const def of defs) {
      const queued = (state.queues?.expedition || []).some(entry => entry.id === def.id);
      const cost = api().helpers?.expeditionCost?.(def) || def.cost;
      if (!state.expeditions[def.id] && !queued && (!def.landing || def.landing === state.landing) &&
          state.pop >= def.reqPop) {
        if (settings.crafting && craftMissingFor(cost, state, demand)) return;
        if (affordable(cost, state, demand) && invoke('expedition', def.id)) return;
      }
    }
  }

  function combatContacts(state) {
    const contacts = state?.diplomacy && typeof state.diplomacy === 'object'
      ? Object.entries(state.diplomacy).map(([id, entry]) => [id, entry || {}]) : [];
    const enemies = state?.enemies && typeof state.enemies === 'object'
      ? (Array.isArray(state.enemies)
        ? state.enemies.map((entry, index) => [entry?.id || entry?.nation || index, entry || {}])
        : Object.entries(state.enemies).map(([id, entry]) => [id, entry || {}])) : [];
    const merged = new Map([...contacts, ...enemies]);
    return [...merged.entries()]
      .filter(([id, entry]) => id && !entry.conquered &&
        (entry.enemy === true || entry.hostile === true ||
          ['enemy', 'hostile'].includes(String(entry.relation || entry.status || '').toLowerCase()) ||
          ((entry.disposition === undefined || Number(entry.disposition) < 0) &&
            (entry.attack !== undefined || entry.attackPower !== undefined ||
              entry.spy !== undefined || entry.spyLevel !== undefined))));
  }

  function combatReduction(entry) {
    if (Number.isFinite(Number(entry.espionageReduction)) &&
        Number.isFinite(Number(entry.maximumEspionageReduction))) {
      return {
        complete: Number(entry.espionageReduction) >= Number(entry.maximumEspionageReduction),
        known: true,
      };
    }
    const espionage = entry.espionage || entry.spyStatus ||
      (entry.spy && typeof entry.spy === 'object' ? entry.spy : {});
    const current = entry.reduction ?? entry.reduced ?? entry.spyLevel ??
      (Number.isFinite(Number(entry.spy)) ? entry.spy : undefined) ??
      espionage.reduction ?? espionage.reduced ?? espionage.level;
    const maximum = entry.maxReduction ?? entry.spyMax ?? entry.maxSpyLevel ??
      espionage.maxReduction ?? espionage.maxLevel;
    if (current === true || espionage.reduced === true) return { complete: true, known: true };
    if (Number.isFinite(Number(current)) && Number.isFinite(Number(maximum))) {
      return { complete: Number(current) >= Number(maximum), known: true };
    }
    return { complete: false, known: current !== undefined };
  }

  function combatAction(names, id, ...args) {
    for (const name of names) {
      if (api().actions?.[name] || api().action) {
        return invoke(name, id, ...args);
      }
    }
    return false;
  }

  function combatGuardCapacity(state) {
    const limits = api().helpers?.guardLimits?.();
    if (Number.isFinite(Number(limits?.maximum))) return Math.max(0, Math.floor(Number(limits.maximum)));
    const reported = api().helpers?.jobCapacity?.('guard');
    if (Number.isFinite(Number(reported))) return Math.max(0, Math.floor(Number(reported)));
    return Math.max(0, Math.floor(Number(state.bld?.barracks || 0)) * 2);
  }

  function siegeCanWin(state, id, entry, healthy) {
    if (entry.conquerable === true || entry.canConquer === true || entry.siegeReady === true || entry.siege?.canWin === true) {
      return true;
    }
    const canWin = api().helpers?.canWinSiege;
    if (typeof canWin === 'function') {
      try {
        return !!canWin(id, healthy);
      } catch (_) {
        // Fall through to compatibility checks.
      }
    }
    const chance = Number(entry.siegeChance ?? entry.siege?.winChance);
    if (Number.isFinite(chance)) return chance >= 0.65;

    const helper = api().helpers?.canConquer || api().helpers?.canSiege;
    if (typeof helper === 'function') {
      try {
        if (helper(id, state)) return true;
      } catch (_) {
        // Fall through to the conservative numeric check.
      }
    }

    const own = Number(state.siegeAttack ?? state.combat?.siegeAttack ??
      state.military?.siegeAttack ?? state.combat?.attack ?? state.military?.attack);
    const guardAttack = Number(state.guardAttack ?? state.combat?.guardAttack);
    const total = Number.isFinite(own) ? own : Number.isFinite(guardAttack) ? healthy * guardAttack : NaN;
    const defense = Number(entry.siegeDefense ?? entry.siege?.defense ??
      entry.defense ?? entry.fortification);
    // Keep a margin for a siege rather than treating an even matchup as safe.
    return Number.isFinite(total) && Number.isFinite(defense) && total >= defense * 1.25;
  }

  function siegeTarget(state, enemies, healthy) {
    const candidates = enemies.filter(([id, entry]) => siegeCanWin(state, id, entry, healthy));
    if (!candidates.length) return null;
    return candidates.sort((a, b) => {
      const defenseA = Number(a[1].siegeDefense ?? a[1].siege?.defense ?? a[1].defense ?? a[1].fortification);
      const defenseB = Number(b[1].siegeDefense ?? b[1].siege?.defense ?? b[1].defense ?? b[1].fortification);
      return (Number.isFinite(defenseA) ? defenseA : Infinity) -
        (Number.isFinite(defenseB) ? defenseB : Infinity);
    })[0];
  }

  function guardAttackPower(state) {
    const reported = api().helpers?.guardAttackPower?.(1) ?? api().helpers?.guardAttack?.();
    if (Number.isFinite(Number(reported)) && Number(reported) > 0) return Number(reported);
    const value = Number(state.guardAttack ?? state.combat?.guardAttack ?? state.military?.guardAttack);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function attackSize(state, entry, healthy, siege = false) {
    const threat = Number(siege
      ? entry.siegeDefense ?? entry.siege?.defense ?? entry.defense ?? entry.fortification
      : entry.attack ?? entry.attackPower ?? entry.defense ?? entry.military?.attack);
    const minimum = Math.max(2, Math.ceil(combatGuardCapacity(state) * 0.5));
    if (!Number.isFinite(threat)) return Math.min(healthy, minimum);
    const needed = Math.ceil((threat * 1.25) / guardAttackPower(state));
    return Math.min(healthy, Math.max(minimum, needed));
  }

  function guardLimits(state) {
    const limits = api().helpers?.guardLimits?.();
    if (limits && Number.isFinite(Number(limits.healthy))) {
      return {
        minimum: Math.max(1, Math.floor(Number(limits.minimum) || 1)),
        maximum: Math.max(0, Math.floor(Number(limits.maximum) || 0)),
        healthy: Math.max(0, Math.floor(Number(limits.healthy) || 0)),
      };
    }
    const capacity = combatGuardCapacity(state);
    const guards = Math.max(0, Math.floor(Number(state.jobs?.guard || 0)));
    const injuries = Math.max(0, Math.floor(Number(state.guardInjuries || 0)));
    return { minimum: 2, maximum: capacity, healthy: Math.max(0, guards - injuries) };
  }

  function plannedAttack(id, count) {
    const predict = api().helpers?.predictAttack;
    if (typeof predict !== 'function') return null;
    try {
      return predict(id, 'raid', count);
    } catch (_) {
      return null;
    }
  }

  function plannedStage(id, stageId, count) {
    const predict = api().helpers?.predictAttack;
    if (typeof predict !== 'function') return null;
    try {
      return predict(id, stageId, count);
    } catch (_) {
      return null;
    }
  }

  function plannedSiege(id, count) {
    const predict = api().helpers?.predictSiege;
    if (typeof predict !== 'function') return null;
    try {
      return predict(id, count);
    } catch (_) {
      return null;
    }
  }

  function minimumWinningCount(planner, id, limits) {
    for (let count = limits.minimum; count <= limits.healthy; count++) {
      const plan = planner(id, count);
      if (plan?.likelyWin) return { count, plan };
    }
    return null;
  }

  function bestAttackPlan(id, state, demand, limits) {
    // Higher stages buy better loot, so choose the strongest affordable stage
    // that still has a modeled likely win. Count is minimized within that stage.
    for (let index = COMBAT_STAGES.length - 1; index >= 0; index--) {
      const stage = COMBAT_STAGES[index];
      if (!affordable(stage.cost, state, demand)) continue;
      const plan = minimumWinningCount((target, count) =>
        plannedStage(target, stage.id, count), id, limits);
      if (plan) return { ...plan, stage: stage.id };
    }
    return null;
  }

  function knownEnemyAttack(entry) {
    const value = entry.knownEnemyAttack ??
      (entry.militaryKnown === true ? entry.enemyAttack : undefined) ??
      (entry.enemy === true ? entry.attack ?? entry.attackPower : undefined);
    if (value === null || value === undefined || value === '') return NaN;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : NaN;
  }

  function chooseCombatTarget(enemies) {
    const known = enemies.filter(([, entry]) => Number.isFinite(knownEnemyAttack(entry)))
      .sort((a, b) => knownEnemyAttack(a[1]) - knownEnemyAttack(b[1]));
    if (known.length) return known[0];
    const byDisposition = enemies.filter(([, entry]) => Number.isFinite(Number(entry.disposition)))
      .sort((a, b) => Number(a[1].disposition) - Number(b[1].disposition));
    return byDisposition[0] || enemies[Math.floor(Math.random() * enemies.length)];
  }

  function autoCombat(state, demand = {}) {
    if (!settings.combat) return;
    const enemies = combatContacts(state);
    if (!enemies.length) return;

    // Espionage comes first and gets one action per automation pass. This
    // keeps a newly discovered enemy from being attacked before its strength
    // has been reduced as far as the game allows.
    const spyTarget = enemies.find(([, entry]) => !combatReduction(entry).complete);
    if (spyTarget) {
      const entry = spyTarget[1];
      const exactEspionage = entry.hostile !== undefined || entry.espionageReduction !== undefined ||
        entry.spies !== undefined || entry.espionageT !== undefined;
      if (exactEspionage) {
        if (Number(entry.espionageT || 0) > 0 || state.spyTraining?.target === spyTarget[0]) return;
        if (Number(entry.spies || 0) < 1) {
          if (combatAction(['sendSpy', 'spyHire'], spyTarget[0])) return;
        } else if (combatAction(['startEspionage', 'espionage'], spyTarget[0])) return;
        return;
      }
      if (combatAction(['spy', 'sendSpy', 'espionage'], spyTarget[0])) return;
    }

    const limits = guardLimits(state);
    const healthy = limits.healthy;
    const capacity = limits.maximum;
    if (typeof api().helpers?.guardLimits !== 'function' && Number(state.guardInjuries || 0) > 0) return;
    // Two healthy guards is the smallest force worth committing, while half
    // a built barracks force prevents premature attacks in larger settlements.
    const minimumAttackSize = typeof api().helpers?.guardLimits === 'function'
      ? limits.minimum : Math.max(2, Math.ceil(capacity * 0.5));
    if (healthy < minimumAttackSize) return;

    const exactPlanner = typeof api().helpers?.predictSiege === 'function' &&
      typeof api().helpers?.predictAttack === 'function';
    if (exactPlanner) {
      const conquerable = enemies.filter(([, entry]) => entry.conquerable === true);
      const conquestTarget = chooseCombatTarget(conquerable);
      if (conquestTarget && healthy >= 15 && combatAction(['conquer'], conquestTarget[0])) return;

      const siegeCandidates = enemies.filter(([, entry]) => entry.conquerable !== true)
        .map(([id, entry]) => [id, entry, minimumWinningCount(plannedSiege, id, limits)])
        .filter(([, , plan]) => plan);
      const siege = siegeCandidates.sort((a, b) => {
        const aAttack = knownEnemyAttack(a[1]);
        const bAttack = knownEnemyAttack(b[1]);
        return (Number.isFinite(aAttack) ? aAttack : Infinity) -
          (Number.isFinite(bAttack) ? bAttack : Infinity);
      })[0];
      if (siege && combatAction(['siege'], siege[0], siege[2].count)) return;

      const target = chooseCombatTarget(enemies);
      if (!target) return;
      const plan = bestAttackPlan(target[0], state, demand, limits);
      if (plan) combatAction(['attack'], target[0], plan.stage, plan.count);
      return;
    }

    const siege = siegeTarget(state, enemies, healthy);
    if (siege) {
      const force = attackSize(state, siege[1], healthy, true);
      if (combatAction(['conquer', 'siege', 'conquerNation', 'siegeNation'], siege[0], force)) return;
    }

    const target = chooseCombatTarget(enemies);
    if (target) combatAction(['attack', 'attackNation', 'invade'], target[0], attackSize(state, target[1], healthy));
  }

  function wonderFindCost(def, state) {
    const helper = api().helpers?.wonderFindCost;
    if (typeof helper === 'function') return helper(def);
    const beacons = Object.values(state.beaconsLit || {}).filter(Boolean).length;
    const multiplier = Math.max(1.05, 1.80 - 0.15 * Math.max(0, beacons - 1));
    return Object.fromEntries(Object.entries(def?.findCost || {})
      .map(([id, amount]) => [id, Math.ceil(amount * multiplier)]));
  }

  function affordableWonderFind(cost, state, demand) {
    const survey = Number(cost?.survey || 0);
    return Number(state.surveyPoints || 0) >= survey &&
      affordable(Object.fromEntries(Object.entries(cost || {})
        .filter(([id]) => id !== 'survey')), state, demand);
  }

  function wonderGuardCapacity(state) {
    const reported = api().helpers?.jobCapacity?.('guard');
    if (Number.isFinite(Number(reported))) return Math.max(0, Math.floor(Number(reported)));
    return Math.max(0, Math.floor(Number(state.bld?.barracks || 0)) * 2);
  }

  function wonderGuardsReady(state) {
    const capacity = wonderGuardCapacity(state);
    const guards = Math.max(0, Math.floor(Number(state.jobs?.guard || 0)));
    const injuries = Math.max(0, Math.floor(Number(state.guardInjuries || 0)));
    return capacity > 0 && guards >= capacity && injuries === 0;
  }

  function wonderObstacleQueued(state) {
    const prefix = `wonderObstacle:${state.landing}:`;
    return (state.queues?.build || []).some(entry =>
      typeof entry.id === 'string' && entry.id.startsWith(prefix));
  }

  function autoWonderStart(state, demand) {
    if (!settings.wonderStart || !(api().actions?.findWonder || api().action)) return;
    const def = (definitions().WONDERS || []).find(item => item.id === state.landing);
    const record = state.wonders?.[state.landing];
    if (!def || record?.found || (record?.outcomes && Object.keys(record.outcomes).length >= 3) ||
        !state.techs?.optics || !state.beaconsLit?.[state.landing] ||
        !state.beaconRevisited?.[state.landing] || !wonderGuardsReady(state)) return;
    const cost = wonderFindCost(def, state);
    if (affordableWonderFind(cost, state, demand)) invoke('findWonder');
  }

  function autoWonderHandle(state, demand = {}) {
    if (!settings.wonderHandle) return;
    const record = state.wonders?.[state.landing];
    if (!record?.found) return;
    const section = (record.sections || []).findIndex(done => !done);
    if (section < 0) return; // The final fate is deliberately left manual.

    // Construction workers do not need a full expedition party. Keep only a
    // small two-person foothold while an obstacle is waiting in the queue.
    if (wonderObstacleQueued(state)) {
      const workers = Math.max(0, Math.floor(Number(state.rapture?.workers || 0)));
      if (workers > 2) invoke('assignRapture', 2 - workers);
      else if (workers < 2) {
        const jobDefs = definitions().JOBS || {};
        const donorMinimum = id => id === 'forager' ? 1 : 0;
        const workingOnDemand = id => {
          const resource = jobDefs[id]?.res;
          return !!resource && Number(demand[resource] || 0) > 0;
        };
        const donorIds = () => Object.keys(snapshot()?.jobs || state.jobs || {})
          .filter(id => id !== 'guard' && jobDefs[id] && !jobDefs[id].targeted &&
            !workingOnDemand(id) &&
            Number((snapshot()?.jobs || state.jobs)[id] || 0) > donorMinimum(id));
        let available = availableWorkers(state);
        while (available < 2 - workers) {
          const jobs = snapshot()?.jobs || state.jobs || {};
          const donor = donorIds().sort((a, b) => Number(jobs[b] || 0) - Number(jobs[a] || 0))[0];
          if (!donor) break;
          const before = jobCount(donor);
          const target = Math.max(donorMinimum(donor), before - Math.max(1, 2 - workers - available));
          if (!invoke('setJob', donor, target) && !invoke('assign', donor, target - before)) break;
          if (jobCount(donor) >= before) break;
          available = availableWorkers(snapshot());
        }
        if (available > 0) invoke('assignRapture', Math.min(2 - workers, available));
      }
      return;
    }

    // These actions are optional until the game exposes them through its
    // public automation API. Rapture staffing is already available today.
    if (api().actions?.wonderResearch) {
      for (let index = 0; index <= section; index++) {
        if (!record.researches?.[index] && invoke('wonderResearch', index)) return;
      }
    }
    if (api().actions?.wonderExpedition) {
      for (let index = 0; index <= section; index++) {
        if (!record.expeditions?.[index] && invoke('wonderExpedition', index)) return;
      }
    }
    if (api().actions?.wonderObstacle && invoke('wonderObstacle')) {
      const after = snapshot();
      if (wonderObstacleQueued(after)) {
        const workers = Math.max(0, Math.floor(Number(after.rapture?.workers || 0)));
        if (workers > 2) invoke('assignRapture', 2 - workers);
      }
      return;
    }

    const capacity = Math.max(0, Math.floor(Number(state.jobs?.guard || 0)) * 2);
    const workers = Math.max(0, Math.floor(Number(state.rapture?.workers || 0)));
    // A zero-worker Wonder assignment is a new attempt. Wait for the full,
    // healthy Guard force rather than feeding villagers into an uncovered run.
    if (workers === 0 && !wonderGuardsReady(state)) return;
    const needed = Math.max(0, capacity - workers);
    if (!needed) return;

    // Rapture workers are villagers, not Guards. If all villagers are already
    // assigned, reclaim ordinary production seats before sending them in.
    const jobDefs = definitions().JOBS || {};
    const donorMinimum = id => id === 'forager' ? 1 : 0;
    const workingOnDemand = id => {
      const resource = jobDefs[id]?.res;
      return !!resource && Number(demand[resource] || 0) > 0;
    };
    const donorIds = () => Object.keys(snapshot()?.jobs || state.jobs || {})
      .filter(id => id !== 'guard' && jobDefs[id] && !jobDefs[id].targeted &&
        !workingOnDemand(id) &&
        Number((snapshot()?.jobs || state.jobs)[id] || 0) > donorMinimum(id))
      .sort((a, b) => {
        const jobs = snapshot()?.jobs || state.jobs || {};
        const aOrder = JOB_ORDER.indexOf(a);
        const bOrder = JOB_ORDER.indexOf(b);
        return Number(jobs[b] || 0) - Number(jobs[a] || 0) ||
          (bOrder === -1 ? -1 : aOrder === -1 ? 1 : bOrder - aOrder);
      });
    let available = availableWorkers(state);
    while (available < needed) {
      const donor = donorIds()[0];
      if (!donor) break;
      const before = jobCount(donor);
      const target = Math.max(donorMinimum(donor), before - Math.max(1, needed - available));
      if (!invoke('setJob', donor, target) && !invoke('assign', donor, target - before)) break;
      const after = jobCount(donor);
      if (after >= before) break;
      available = availableWorkers(snapshot());
    }
    if (available > 0) {
      invoke('assignRapture', Math.min(needed, available));
    }
  }

  function automationStep() {
    if (busy || !settings.enabled || !api()?.getState) return;
    busy = true;
    try {
      if (!snapshot()) return;
      lastAction = 'Scanning Emberhold';
      for (const [setting, step] of [
        ['power', autoFactory], ['power', autoPower], ['jobs', autoMorale], ['jobs', autoJobs], ['research', autoResearch],
        ['buildings', autoBuildings], ['crafting', autoCraft],
        ['diplomacy', autoDiplomacy], ['expeditions', autoExpeditions],
        ['combat', autoCombat],
        ['wonderHandle', autoWonderHandle], ['wonderStart', autoWonderStart],
      ]) {
        if (settings[setting]) step(snapshot(), queuedDemand());
      }
      if (lastAction === 'Scanning Emberhold') lastAction = 'No eligible action';
      updatePanel(snapshot());
    } catch (error) {
      lastAction = `Automation error: ${error?.message || error}`;
      console.error('[Emberhold Automation]', lastAction, error);
      updatePanel(snapshot());
    } finally {
      busy = false;
    }
  }

  function makePanel() {
    if (document.getElementById('emberhold-automation')) return;
    const panel = document.createElement('details');
    panel.id = 'emberhold-automation';
    panel.open = true;
    panel.innerHTML = `<summary>Emberhold Automation</summary>
      <div class="ea-body"><label><input data-setting="enabled" type="checkbox"> Enabled</label>
      <div class="ea-grid">${[
        ['jobs', 'Jobs'], ['research', 'Research'], ['buildings', 'Buildings'],
        ['crafting', 'Crafting'], ['diplomacy', 'Diplomacy'],
        ['combat', 'Combat'],
        ['expeditions', 'Expeditions'], ['power', 'Power'],
        ['wonderStart', 'Start Wonders'], ['wonderHandle', 'Handle Wonders'],
      ].map(([id, label]) => `<label><input data-setting="${id}" type="checkbox"> ${label}</label>`).join('')}</div>
      <label>Loop delay <select data-setting="interval"><option value="500">0.5s</option><option value="1000">1s</option><option value="2000">2s</option><option value="5000">5s</option></select></label>
      <div class="ea-status" data-status>Waiting for Emberhold</div></div>`;
    document.body.appendChild(panel);
    const style = document.createElement('style');
    style.textContent = '#emberhold-automation{position:fixed;right:1rem;bottom:1rem;z-index:2147483647!important;background:#211810;color:#f2d49a;border:1px solid #8d6739;padding:.55rem;max-width:18rem;font:13px sans-serif;box-shadow:0 4px 18px #0008}#emberhold-automation summary{cursor:pointer;font-weight:bold}.ea-body{display:grid;gap:.45rem;padding-top:.5rem}.ea-grid{display:grid;grid-template-columns:1fr 1fr;gap:.2rem .7rem}.ea-status{color:#c9a86b;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
    document.head.appendChild(style);
    panel.querySelectorAll('[data-setting]').forEach(input => {
      const key = input.dataset.setting;
      if (input.type === 'checkbox') input.checked = !!settings[key];
      else input.value = String(settings[key]);
      input.addEventListener('change', () => {
        settings[key] = input.type === 'checkbox' ? input.checked : Number(input.value);
        saveSettings();
        restart();
      });
    });
  }

  function updatePanel(state) {
    const status = document.querySelector('#emberhold-automation [data-status]');
    const current = state?.state || state;
    const power = current?.power;
    const powerText = power && Number.isFinite(power.generated) && Number.isFinite(power.used)
      ? ` · Power ${power.generated.toFixed(1)} in / ${power.used.toFixed(1)} used; factories reserve ${((current.bld?.factory || 0) * FACTORY_POWER_REQUIREMENT).toFixed(1)}` : '';
    if (status) {
      status.textContent = `${lastAction} · day ${Number.isFinite(current?.day) ? Math.floor(current.day) : 'unknown'}${powerText}`;
      status.title = status.textContent;
    }
  }

  function restart() {
    if (timer) clearInterval(timer);
    timer = setInterval(automationStep, Math.max(250, settings.interval));
  }

  function boot() {
    if (typeof api()?.getState !== 'function') return setTimeout(boot, 250);
    lastAction = api().actions ? 'Connected to Emberhold' : api().action ? 'Connected (legacy API)' : 'State API only — actions unavailable';
    makePanel();
    if (typeof api().subscribe === 'function') api().subscribe(updatePanel);
    restart();
    automationStep();
  }

  boot();
})();
