// ==UserScript==
// @name         Emberhold Automation
// @namespace    https://github.com/emberhold
// @version      1.30.32
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
    logicOverrides: {},
    ownBuildQueue: [],
    ownResearchQueue: [],
  };

  const UI_DEFAULTS = {
    panelCollapsed: false,
    settingsCollapsed: true,
    categoryCollapsed: {
      core: false,
      queues: true,
      jobs: true,
      research: true,
      buildings: true,
      production: true,
      power: true,
      diplomacy: true,
      expeditions: true,
      combat: true,
      wonders: true,
      diagnostics: true,
    },
  };

  let settings = loadSettings();
  let timer = null;
  let busy = false;
  let lastAction = 'Waiting for Emberhold';
  let lastInvocationResult;
  let combatSuccessStreak = 0;
  let combatLossStreak = 0;
  const pausedDiplomats = Object.create(null);
  let uiSettings = loadUiSettings();

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

  function exportSettings() {
    return JSON.stringify(settings, null, 2);
  }

  function importSettings(text) {
    let imported;
    try {
      imported = JSON.parse(text);
      if (!imported || Array.isArray(imported) || typeof imported !== 'object') throw new Error('Settings must be a JSON object');
    } catch (error) {
      return `Import failed: ${error.message}`;
    }
    settings = { ...DEFAULTS, ...imported, logicOverrides: imported.logicOverrides || {} };
    saveSettings();
    restart();
    const panel = document.getElementById('emberhold-automation');
    if (panel) refreshSettingInputs(panel);
    return 'Settings imported';
  }

  function downloadSettings() {
    const blob = new Blob([exportSettings()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'emberhold-automation-settings.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  function loadUiSettings() {
    try {
      const stored = JSON.parse(localStorage.getItem(`${SETTINGS_KEY}_ui`) || '{}');
      return {
        ...UI_DEFAULTS,
        ...stored,
        categoryCollapsed: { ...UI_DEFAULTS.categoryCollapsed, ...(stored.categoryCollapsed || {}) },
      };
    } catch (_) {
      return {
        ...UI_DEFAULTS,
        categoryCollapsed: { ...UI_DEFAULTS.categoryCollapsed },
      };
    }
  }

  function saveUiSettings() {
    localStorage.setItem(`${SETTINGS_KEY}_ui`, JSON.stringify(uiSettings));
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
      lastInvocationResult = result;
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
    const demand = !state?.settings?.strictQueueOrder ? (api().helpers?.queueDemand?.() || {}) : {};
    if (!state?.settings?.strictQueueOrder) return mergeDemand(demand, ownQueueDemand(state));

    // In strict mode the game only considers the first entry in each queue.
    // Do not reserve resources for later entries: doing so can prevent the
    // active entry from ever becoming affordable.
    const gameDemand = {};
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
        gameDemand[resource] = (gameDemand[resource] || 0) + amount;
      }
    }
    return mergeDemand(gameDemand, ownQueueDemand(state));
  }

  function mergeDemand(first, second) {
    const merged = { ...(first || {}) };
    for (const [id, amount] of Object.entries(second || {})) merged[id] = (merged[id] || 0) + amount;
    return merged;
  }

  function queueDefinition(type, id) {
    const list = type === 'build' ? definitions().BUILDINGS : definitions().TECHS;
    return (list || []).find(def => def.id === id);
  }

  function ownQueueDemand(state) {
    const demand = {};
    for (const [type, queue] of [['build', settings.ownBuildQueue], ['research', settings.ownResearchQueue]]) {
      const id = Array.isArray(queue) ? queue[0] : null;
      const def = id && queueDefinition(type, id);
      if (!def) continue;
      const cost = type === 'build'
        ? (api().helpers?.buildingCost?.(def) || def.cost)
        : researchCost(def);
      for (const [resource, amount] of Object.entries(cost || {})) {
        demand[resource] = (demand[resource] || 0) + amount;
      }
    }
    return demand;
  }

  function demandForOwnAction(type, state, demand) {
    const id = type === 'build' ? settings.ownBuildQueue?.[0] : settings.ownResearchQueue?.[0];
    const def = id && queueDefinition(type, id);
    if (!def) return demand;
    const cost = type === 'build'
      ? (api().helpers?.buildingCost?.(def) || def.cost)
      : researchCost(def);
    const result = { ...(demand || {}) };
    for (const [resource, amount] of Object.entries(cost || {})) {
      result[resource] = Math.max(0, (result[resource] || 0) - amount);
    }
    return result;
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
    // An empty stockpile is not itself a blocker: if net food is positive,
    // moving an idle or surplus worker to morale duty does not worsen food
    // production, and waiting here can leave morale permanently depressed.
    if (rates.food < 0) return false;

    const partners = Array.isArray(state.tradePartners)
      ? (state.tradePartner && state.tradePartners[0] !== state.tradePartner
        ? [state.tradePartner] : state.tradePartners)
      : [state.tradePartner];
    const commonality = state.techs?.commonality && state.policy === 'commonality';
    const conquered = commonality ? 0 : [...new Set(partners)]
      .filter(id => id && state.diplomacy?.[id]?.conquered).length;
    const telemetry = api().helpers?.morale?.();
    const liveRate = Number(telemetry?.rate ?? api().helpers?.moraleRate?.());
    const marginal = Number(api().helpers?.marginalMorale?.('performer'));
    // Prefer the game's live morale equation. A small positive margin keeps
    // recovery going as low-morale bonuses disappear and new penalties appear.
    // The legacy estimate remains for older game builds without telemetry.
    const target = Number.isFinite(liveRate) && marginal > 0
      ? performers + Math.max(0, Math.ceil((0.025 - liveRate) / marginal - 1e-9))
      : Math.ceil((Math.max(0, state.pop - 20) * 0.01 +
        Number(state.bld?.livingBlock || 0) * 0.1 + conquered +
        0.060 + 0.006 + 0.008 + 0.025) / 0.10);
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
    let releasedWorkers = 0;
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
      releasedWorkers += released;
      rates[defs[id].res] -= released * rate;
    }
    // A released worker is a transfer from an existing job, not an additional
    // population slot. Include those releases even though the live unassigned
    // count may still be zero until the performer assignment is applied.
    const additions = Math.min(target - performers,
      availableWorkers(snapshot()) + releasedWorkers);
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

  function autoOwnQueue(type, state, demand) {
    const key = type === 'build' ? 'ownBuildQueue' : 'ownResearchQueue';
    const action = type === 'build' ? 'build' : 'research';
    const queue = settings[key];
    if (!Array.isArray(queue) || !queue.length) return false;
    const id = queue[0];
    const def = queueDefinition(type, id);
    if (!def) return false;
    const finished = type === 'build'
      ? Number(state.bld?.[id] || 0) >= Number(def.max || 1)
      : !!state.techs?.[id];
    if (finished) {
      settings[key] = queue.slice(1);
      saveSettings();
      return true;
    }
    if ((state.queues?.[type] || []).some(entry => entry.id === id)) return false;
    const cost = type === 'build'
      ? (api().helpers?.buildingCost?.(def) || def.cost)
      : researchCost(def);
    return unlocked(def, state) && affordable(cost, state, demandForOwnAction(type, state, demand)) && invoke(action, id);
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
        if (!invoke(name, id, ...args)) return false;
        return { name, result: lastInvocationResult };
      }
    }
    return false;
  }

  function recordCombatOutcome(action) {
    if (!action) {
      combatSuccessStreak = 0;
      return;
    }
    const result = action?.result;
    if (!result || (result.action !== 'attack' && result.action !== 'raid')) return;
    if (result.ok && result.succeeded === true) {
      combatSuccessStreak++;
      combatLossStreak = 0;
    } else if (result.ok && result.succeeded === false) {
      combatSuccessStreak = 0;
      combatLossStreak++;
    }
  }

  function escalatedAttackCount(count, limits) {
    if (combatLossStreak > 0) {
      return Math.min(limits.healthy, count + combatLossStreak);
    }
    if (combatSuccessStreak < 2) return count;
    return Math.min(limits.healthy, count + combatSuccessStreak - 1);
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

  function chanceFraction(plan) {
    const chance = Number(plan?.chance);
    if (!Number.isFinite(chance)) return NaN;
    return chance > 1 ? chance / 100 : chance;
  }

  function minimumWinningCount(planner, id, limits) {
    let likelyWin;
    for (let count = limits.minimum; count <= limits.healthy; count++) {
      const plan = planner(id, count);
      if (plan?.likelyWin && !likelyWin) likelyWin = { count, plan };
      if (chanceFraction(plan) >= 0.75) return { count, plan };
    }
    return likelyWin || null;
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
        const hasSpyTech = !!state.techs?.spies || api().helpers?.tech?.('spies') === true;
        const hasEspionageTech = !!state.techs?.espionage || api().helpers?.tech?.('espionage') === true;
        if (Number(entry.espionageT || 0) <= 0 && state.spyTraining?.target !== spyTarget[0]) {
          if (Number(entry.spies || 0) < 1 && hasSpyTech) {
            if (combatAction(['sendSpy', 'spyHire'], spyTarget[0])) return;
          } else if (Number(entry.spies || 0) >= 1 && hasEspionageTech &&
              combatAction(['startEspionage', 'espionage'], spyTarget[0])) return;
        }
        // Intelligence is helpful but optional. Continue to a cautious raid
        // when spying is locked, unavailable, or still in progress.
      } else if (combatAction(['spy', 'sendSpy', 'espionage'], spyTarget[0])) return;
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
      if (!Number.isFinite(knownEnemyAttack(target[1]))) {
        const stage = COMBAT_STAGES[0];
        if (limits.healthy >= limits.minimum && affordable(stage.cost, state, demand)) {
          const action = combatAction(['attack'], target[0], stage.id,
            escalatedAttackCount(limits.minimum, limits));
          recordCombatOutcome(action);
        }
        return;
      }
      const plan = bestAttackPlan(target[0], state, demand, limits);
      if (plan) {
        const action = combatAction(['attack'], target[0], plan.stage,
          escalatedAttackCount(plan.count, limits));
        recordCombatOutcome(action);
      }
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
      // Emberhold may redraw its panels; remount the embedded controls if the
      // host panel was replaced during a tab or view change.
      makePanel();
      if (!snapshot()) return;
      lastAction = 'Scanning Emberhold';
      let moraleChanged = false;
      for (const [setting, step] of [
        ['buildings', state => autoOwnQueue('build', state, queuedDemand(state))],
        ['research', state => autoOwnQueue('research', state, queuedDemand(state))],
        ['power', autoFactory], ['power', autoPower], ['jobs', autoMorale], ['jobs', autoJobs], ['research', autoResearch],
        ['buildings', autoBuildings], ['crafting', autoCraft],
        ['diplomacy', autoDiplomacy], ['expeditions', autoExpeditions],
        ['combat', autoCombat],
        ['wonderHandle', autoWonderHandle], ['wonderStart', autoWonderStart],
      ]) {
        if (!logicValue(setting, snapshot(), settings[setting])) continue;
        // autoJobs can immediately reclaim a villager that autoMorale just
        // moved into performers (usually to satisfy a wood shortage). Let the
        // targeted morale assignment settle for one tick before ordinary job
        // balancing runs again.
        if (step === autoJobs && moraleChanged) continue;
        const changed = step(snapshot(), queuedDemand());
        if (step === autoMorale && changed) moraleChanged = true;
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

  function panelHost() {
    const selectors = [
      '#resources', '#left-panel', '#leftPanel', '#sidebar', '#game-sidebar',
      'aside', 'main', '[role="main"]', '#app', '#game',
    ];
    return selectors.map(selector => document.querySelector(selector)).find(Boolean) || document.body;
  }

  function gameSettingsHost() {
    const chronicleHeading = Array.from(document.querySelectorAll('h1,h2,h3,h4,legend,div,section'))
      .find(node => node.children.length === 0 && /^\s*chronicle tools\s*$/i.test(node.textContent || ''));
    if (chronicleHeading) return chronicleHeading.closest('section, article') || chronicleHeading.parentElement;

    // Avoid generic `.settings` selectors: Emberhold also uses that name for
    // the navigation button, which would place the controls beside the tab.
    const selectors = ['#settings-view', '.settings-view', '[data-screen="settings"]', '[data-view="settings"]'];
    return selectors.map(selector => document.querySelector(selector))
      .find(node => node && !['BUTTON', 'A'].includes(node.tagName)) || null;
  }

  function moveDetailedSettings(panel) {
    const detail = panel.querySelector('.ea-settings') || document.querySelector('#emberhold-automation-settings .ea-settings');
    const host = gameSettingsHost();
    if (!detail || !host || host === panel || host.contains(detail)) return;
    let wrapper = document.getElementById('emberhold-automation-settings');
    if (!wrapper) {
      wrapper = document.createElement('section');
      wrapper.id = 'emberhold-automation-settings';
      wrapper.className = 'ea-embedded-panel';
    }
    wrapper.appendChild(detail);
    host.appendChild(wrapper);
  }

  function settingInput(key, label, type = 'checkbox') {
    if (type === 'select') {
      return `<label class="ea-setting"><span>${label}</span><select data-setting="${key}">
        <option value="500">0.5s</option><option value="1000">1s</option>
        <option value="2000">2s</option><option value="5000">5s</option>
      </select></label>`;
    }
    return `<label class="ea-setting" title="Shift-click to add conditional logic"><input data-setting="${key}" type="${type}"> <span>${label}</span></label>`;
  }

  function wireSettingInputs(root) {
    root.querySelectorAll('[data-setting]').forEach(input => {
      const key = input.dataset.setting;
      if (input.type === 'checkbox') input.checked = !!settings[key];
      else input.value = String(settings[key]);
      input.addEventListener('change', () => {
        settings[key] = input.type === 'checkbox' ? input.checked : Number(input.value);
        saveSettings();
        restart();
      });
      input.addEventListener('click', event => {
        if (event.shiftKey) {
          event.preventDefault();
          openLogicEditor(key, root.closest('#emberhold-automation'));
        }
      });
    });
  }

  function refreshSettingInputs(root) {
    root.querySelectorAll('[data-setting]').forEach(input => {
      const value = settings[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = !!value;
      else input.value = String(value);
    });
  }

  function readPath(value, path) {
    return String(path || '').split('.').filter(Boolean).reduce((current, part) => current?.[part], value);
  }

  const LOGIC_TYPES = {
    Boolean: { label: 'Boolean', arg: 'boolean' },
    String: { label: 'String', arg: 'text' },
    Number: { label: 'Number', arg: 'number' },
    GameDay: { label: 'Game Day', arg: 'none' },
    Population: { label: 'Population', arg: 'none' },
    Morale: { label: 'Morale', arg: 'none' },
    SettingDefault: { label: 'Setting Default', arg: 'none' },
    SettingCurrent: { label: 'Setting Current', arg: 'none' },
    BuildingCount: { label: 'Building Count', arg: 'building' },
    BuildingEnabled: { label: 'Building Enabled', arg: 'building' },
    BuildingDisabled: { label: 'Building Disabled', arg: 'building' },
    BuildingQueued: { label: 'Building Queued', arg: 'building' },
    ResearchComplete: { label: 'Research Complete', arg: 'research' },
    ResearchUnlocked: { label: 'Research Unlocked', arg: 'research' },
    JobCount: { label: 'Job Count', arg: 'job' },
    JobMax: { label: 'Job Max', arg: 'job' },
    ResourceQuantity: { label: 'Resource Quantity', arg: 'resource' },
    ResourceStorage: { label: 'Resource Storage', arg: 'resource' },
    ResourceIncome: { label: 'Resource Income', arg: 'resource' },
    ResourceRatio: { label: 'Resource Ratio', arg: 'resource' },
    PowerGenerated: { label: 'Power Generated', arg: 'none' },
    PowerUsed: { label: 'Power Used', arg: 'none' },
    QueueCount: { label: 'Queue Count', arg: 'queue' },
  };

  const LOGIC_COMPARATORS = [
    ['==', '=='], ['!=', '!='], ['>', '>'], ['<', '<'], ['>=', '>='], ['<=', '<='],
    ['includes', 'includes'], ['exists', 'exists'],
  ];

  function logicTypeOptions() {
    return Object.entries(LOGIC_TYPES).map(([id, type]) => `<option value="${id}">${type.label}</option>`).join('');
  }

  function logicArgumentOptions(kind) {
    const defs = kind === 'building' ? definitions().BUILDINGS : kind === 'research' ? definitions().TECHS : kind === 'job' ? Object.values(definitions().JOBS || {}) : kind === 'resource' ? Object.values(definitions().RESOURCES || {}) : [];
    if (kind === 'queue') return '<option value="build">Build queue</option><option value="research">Research queue</option><option value="expedition">Expedition queue</option>';
    return (defs || []).map(def => `<option value="${def.id}">${def.name || def.id}</option>`).join('');
  }

  function logicArgumentControl(type, value) {
    const arg = LOGIC_TYPES[type]?.arg;
    if (arg === 'none') return '<span class="ea-logic-no-arg">—</span>';
    if (arg === 'boolean') return `<select data-logic-arg><option value="true"${value !== false ? ' selected' : ''}>true</option><option value="false"${value === false ? ' selected' : ''}>false</option></select>`;
    if (arg === 'text' || arg === 'number') return `<input data-logic-arg type="text" value="${String(value ?? '')}">`;
    return `<select data-logic-arg>${logicArgumentOptions(arg)}</select>`;
  }

  function logicOperand(state, type, arg, settingKey) {
    if (type === 'Boolean') return arg === true || arg === 'true';
    if (type === 'String' || type === 'Number') return arg;
    if (type === 'SettingDefault' || type === 'SettingCurrent') return settings[settingKey];
    if (type === 'PowerGenerated') return Number(state?.power?.generated ?? 0);
    if (type === 'PowerUsed') return Number(state?.power?.used ?? 0);
    if (type === 'GameDay') return Number(state?.day ?? 0);
    if (type === 'Population') return Number(state?.pop ?? 0);
    if (type === 'Morale') return Number(state?.morale ?? 0);
    if (type === 'QueueCount') return (state?.queues?.[arg] || []).length;
    if (type === 'BuildingCount') return Number(state?.bld?.[arg] || 0);
    if (type === 'BuildingQueued') return (state?.queues?.build || []).some(entry => entry.id === arg);
    if (type === 'BuildingEnabled') return Number(state?.buildingPower?.[arg] || state?.power?.buildings?.[arg]?.enabled || 0);
    if (type === 'BuildingDisabled') return Math.max(0, Number(state?.bld?.[arg] || 0) - Number(state?.buildingPower?.[arg] || 0));
    if (type === 'ResearchComplete') return !!state?.techs?.[arg];
    if (type === 'ResearchUnlocked') return !!queueDefinition('research', arg);
    if (type === 'JobCount') return Number(state?.jobs?.[arg] || 0);
    if (type === 'JobMax') return Number((definitions().JOBS?.[arg] || {}).max || 0);
    if (type === 'ResourceQuantity') return Number(state?.res?.[arg] || 0);
    if (type === 'ResourceStorage') return Number(state?.storage?.[arg] || state?.capacity?.[arg] || 0);
    if (type === 'ResourceIncome') return Number(state?.rates?.[arg] || state?.production?.[arg] || 0);
    if (type === 'ResourceRatio') return Number(state?.resRatio?.[arg] || 0);
    return arg;
  }

  function compareLogic(actual, op, expected) {
    if (op === 'exists') return actual !== undefined && actual !== null;
    if (op === '==') return actual == expected;
    if (op === '!=') return actual != expected;
    if (op === '>') return Number(actual) > Number(expected);
    if (op === '>=') return Number(actual) >= Number(expected);
    if (op === '<') return Number(actual) < Number(expected);
    if (op === '<=') return Number(actual) <= Number(expected);
    if (op === 'includes') return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? '').includes(String(expected));
    return false;
  }

  function logicValue(key, state, fallback) {
    const rules = settings.logicOverrides?.[key];
    if (!Array.isArray(rules) || rules.length === 0) return fallback;
    const match = rules.find(rule => {
      if (rule.path) return compareLogic(readPath(state, rule.path), rule.op, rule.value);
      return compareLogic(logicOperand(state, rule.type1, rule.arg1, key), rule.cmp, logicOperand(state, rule.type2, rule.arg2, key));
    });
    return match ? (match.result === undefined ? fallback : !!match.result) : fallback;
  }

  function openLogicEditor(key, panel) {
    if (!panel) return;
    let modal = document.getElementById('ea-settings-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'ea-settings-modal';
      modal.innerHTML = `<div class="ea-modal-content"><button type="button" class="ea-modal-close" aria-label="Close">×</button><div class="ea-modal-header" data-modal-title></div><div class="ea-modal-body"><div id="ea-logic-editor" class="ea-logic-editor"></div></div></div>`;
      document.body.appendChild(modal);
      modal.querySelector('.ea-modal-close').addEventListener('click', () => { modal.hidden = true; });
      modal.addEventListener('click', event => { if (event.target === modal) modal.hidden = true; });
      document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.hidden) modal.hidden = true; });
    }
    modal.hidden = false;
    modal.querySelector('[data-modal-title]').textContent = `Conditional logic · ${key}`;
    let editor = modal.querySelector('#ea-logic-editor');
    if (!editor) {
      editor = document.createElement('div');
      editor.id = 'ea-logic-editor';
      editor.className = 'ea-logic-editor';
    }
    editor.dataset.logicKey = key;
    const legacyType = path => path === 'day' ? 'GameDay' : path === 'pop' ? 'Population' : path === 'morale' ? 'Morale' : path === 'power.generated' ? 'PowerGenerated' : path === 'power.used' ? 'PowerUsed' : path.startsWith('bld.') ? 'BuildingCount' : path.startsWith('res.') ? 'ResourceQuantity' : 'String';
    const legacyArg = path => path.includes('.') ? path.split('.')[1] : '';
    editor._draft = JSON.parse(JSON.stringify(settings.logicOverrides?.[key] || [])).map(rule => rule.path
      ? { type1: legacyType(rule.path), arg1: legacyArg(rule.path), type2: 'Number', arg2: rule.value, cmp: rule.op, result: rule.result }
      : rule);
    const render = () => {
      editor.innerHTML = `<strong>Conditional logic for <code>${key}</code></strong><div class="ea-logic-help">Choose the value type first, then its argument, comparison, second value, and result. Rules are checked top to bottom; the first match wins.</div><table class="ea-logic-table"><thead><tr><th>Variable 1</th><th>Check</th><th>Variable 2</th><th>Result</th><th></th></tr></thead><tbody></tbody></table><div class="ea-logic-actions"><button type="button" data-logic-add>Add rule</button> <button type="button" data-logic-save>Save</button> <button type="button" data-logic-clear>Clear</button><span data-logic-status></span></div>`;
      const body = editor.querySelector('tbody');
      editor._draft.forEach((rule, index) => {
        const row = document.createElement('tr');
        row.innerHTML = `<td><select data-rule-type>${logicTypeOptions()}</select><div data-rule-arg></div></td><td><select data-rule-cmp>${LOGIC_COMPARATORS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></td><td><select data-rule-type2>${logicTypeOptions()}</select><div data-rule-arg2></div></td><td><input data-rule-result type="checkbox" checked></td><td><button type="button" data-rule-remove>−</button></td>`;
        row.querySelector('[data-rule-type]').value = rule.type1 || 'Number';
        row.querySelector('[data-rule-type2]').value = rule.type2 || 'Number';
        row.querySelector('[data-rule-cmp]').value = rule.cmp || '>=';
        row.querySelector('[data-rule-arg]').innerHTML = logicArgumentControl(rule.type1 || 'Number', rule.arg1 ?? 0);
        row.querySelector('[data-rule-arg2]').innerHTML = logicArgumentControl(rule.type2 || 'Number', rule.arg2 ?? 0);
        const arg1 = row.querySelector('[data-rule-arg] [data-logic-arg]');
        const arg2 = row.querySelector('[data-rule-arg2] [data-logic-arg]');
        if (arg1) arg1.value = String(rule.arg1 ?? 0);
        if (arg2) arg2.value = String(rule.arg2 ?? 0);
        row.querySelector('[data-rule-result]').checked = rule.result !== false;
        row.querySelector('[data-rule-type]').addEventListener('change', event => { rule.type1 = event.target.value; rule.arg1 = LOGIC_TYPES[event.target.value].arg === 'boolean' ? true : 0; render(); });
        row.querySelector('[data-rule-type2]').addEventListener('change', event => { rule.type2 = event.target.value; rule.arg2 = LOGIC_TYPES[event.target.value].arg === 'boolean' ? true : 0; render(); });
        row.querySelector('[data-rule-cmp]').addEventListener('change', event => { rule.cmp = event.target.value; });
        row.querySelector('[data-rule-arg]').querySelector('[data-logic-arg]')?.addEventListener('change', event => { rule.arg1 = event.target.value; });
        row.querySelector('[data-rule-arg2]').querySelector('[data-logic-arg]')?.addEventListener('change', event => { rule.arg2 = event.target.value; });
        row.querySelector('[data-rule-result]').addEventListener('change', event => { rule.result = event.target.checked; });
        row.querySelector('[data-rule-remove]').addEventListener('click', () => { editor._draft.splice(index, 1); render(); });
        body.appendChild(row);
      });
      editor.querySelector('[data-logic-add]').addEventListener('click', () => { editor._draft.push({ type1: 'Number', arg1: 0, type2: 'Number', arg2: 50, cmp: '>=', result: false }); render(); });
      editor.querySelector('[data-logic-save]').addEventListener('click', () => { settings.logicOverrides[key] = editor._draft; saveSettings(); editor.querySelector('[data-logic-status]').textContent = ' Saved'; });
      editor.querySelector('[data-logic-clear]').addEventListener('click', () => { editor._draft = []; delete settings.logicOverrides[key]; saveSettings(); render(); });
    };
    render();
    editor.scrollIntoView({ block: 'nearest' });
  }

  function wireUiDetails(root) {
    root.querySelectorAll('[data-ui-detail]').forEach(detail => {
      const key = detail.dataset.uiDetail;
      detail.open = key === 'panel' ? !uiSettings.panelCollapsed : !uiSettings.settingsCollapsed;
      detail.addEventListener('toggle', () => {
        if (key === 'panel') uiSettings.panelCollapsed = !detail.open;
        else uiSettings.settingsCollapsed = !detail.open;
        saveUiSettings();
      });
    });
    root.querySelectorAll('[data-ui-category]').forEach(detail => {
      const key = detail.dataset.uiCategory;
      detail.open = !uiSettings.categoryCollapsed[key];
      detail.addEventListener('toggle', () => {
        uiSettings.categoryCollapsed[key] = !detail.open;
        saveUiSettings();
      });
    });
  }

  function queueOptions(type) {
    const defs = type === 'build' ? definitions().BUILDINGS : definitions().TECHS;
    return (defs || []).map(def => `<option value="${def.id}">${def.name || def.id}</option>`).join('');
  }

  function refreshQueueList(panel, type) {
    const key = type === 'build' ? 'ownBuildQueue' : 'ownResearchQueue';
    const list = panel.querySelector(`[data-queue-list="${type}"]`);
    list.innerHTML = (settings[key] || []).map((id, index) =>
      `<span class="ea-queue-item"><span>${index + 1}. ${id}</span><button type="button" data-queue-remove="${type}" data-queue-index="${index}">×</button></span>`).join('');
    list.querySelectorAll('[data-queue-remove]').forEach(button => button.addEventListener('click', () => {
      settings[key].splice(Number(button.dataset.queueIndex), 1);
      saveSettings();
      refreshQueueList(panel, type);
    }));
  }

  function wireQueueControls(panel) {
    for (const type of ['build', 'research']) {
      panel.querySelector(`[data-queue-add="${type}"]`).addEventListener('click', () => {
        const select = panel.querySelector(`[data-queue-select="${type}"]`);
        const key = type === 'build' ? 'ownBuildQueue' : 'ownResearchQueue';
        if (!select.value) return;
        settings[key] = Array.isArray(settings[key]) ? settings[key] : [];
        settings[key].push(select.value);
        saveSettings();
        refreshQueueList(panel, type);
      });
      refreshQueueList(panel, type);
    }
  }

  function makePanel() {
    const host = panelHost();
    if (host !== document.body) host.classList.add('ea-scroll-host');
    let panel = document.getElementById('emberhold-automation');
    if (!panel) {
      if (!document.getElementById('emberhold-automation-style')) {
        const style = document.createElement('style');
        style.id = 'emberhold-automation-style';
        style.textContent = `
          #emberhold-automation { margin: .75rem 0; width: 100%; box-sizing: border-box; }
          .ea-scroll-host { overflow-y: auto !important; max-height: 100vh; }
          #emberhold-automation details { margin: .25rem 0; }
          #emberhold-automation summary { cursor: pointer; font-weight: 600; }
          #emberhold-automation .ea-body { display: grid; gap: .45rem; padding: .45rem 0; }
          #emberhold-automation .ea-grid, #emberhold-automation .ea-settings-grid {
            display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .3rem .7rem;
          }
          #emberhold-automation .ea-setting { display: flex; align-items: center; gap: .3rem; }
          #emberhold-automation .ea-setting span { min-width: 0; }
          #emberhold-automation select { max-width: 6rem; }
          #emberhold-automation .ea-settings-actions, #emberhold-automation [data-settings-text], #emberhold-automation .ea-import-status { grid-column: 1 / -1; }
          #emberhold-automation .ea-settings-actions { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; }
          #emberhold-automation .ea-queue-settings { display: grid; gap: .35rem; padding: .35rem 0; }
          #emberhold-automation .ea-queue-settings label { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; }
          #emberhold-automation .ea-queue-item { display: flex; justify-content: space-between; gap: .5rem; padding-left: .75rem; }
          #emberhold-automation [data-settings-text], #emberhold-automation [data-logic-text] { width: 100%; box-sizing: border-box; font: .8em monospace; }
          #emberhold-automation .ea-logic-editor { border-top: 1px solid currentColor; margin-top: .5rem; padding-top: .5rem; display: grid; gap: .35rem; }
          #emberhold-automation .ea-logic-help { opacity: .75; font-size: .85em; }
          #emberhold-automation .ea-logic-table { width: 100%; border-collapse: collapse; font-size: .85em; }
          #emberhold-automation .ea-logic-table th, #emberhold-automation .ea-logic-table td { padding: .2rem; text-align: left; }
          #emberhold-automation .ea-logic-table select, #emberhold-automation .ea-logic-table input[type="text"] { width: 100%; min-width: 0; }
          #emberhold-automation .ea-logic-actions { display: flex; flex-wrap: wrap; gap: .3rem; align-items: center; }
          #ea-settings-modal { position: fixed; inset: 0; z-index: 2147483646; background: rgba(10, 10, 10, .86); overflow-y: auto; }
          #ea-settings-modal[hidden] { display: none; }
          #ea-settings-modal .ea-modal-content { position: relative; width: min(1100px, 92vw); min-height: 240px; margin: 5vh auto; padding: 0 1rem 1rem; box-sizing: border-box; border-radius: .5rem; background: inherit; color: inherit; }
          #ea-settings-modal .ea-modal-header { padding: .7rem 2.5rem .7rem 1rem; border-bottom: 1px solid currentColor; font-weight: 700; text-align: center; }
          #ea-settings-modal .ea-modal-body { padding: 1rem; overflow-x: auto; }
          #ea-settings-modal .ea-modal-close { position: absolute; top: .35rem; right: .65rem; border: 0; background: transparent; color: inherit; font-size: 1.8rem; line-height: 1; cursor: pointer; }
          #ea-settings-modal .ea-logic-editor { border-top: 0; margin-top: 0; padding-top: 0; }
          #ea-settings-modal .ea-logic-table { table-layout: fixed; }
          #ea-settings-modal .ea-logic-table th:nth-child(1), #ea-settings-modal .ea-logic-table td:nth-child(1), #ea-settings-modal .ea-logic-table th:nth-child(3), #ea-settings-modal .ea-logic-table td:nth-child(3) { width: 34%; }
          #ea-settings-modal .ea-logic-table th:nth-child(2), #ea-settings-modal .ea-logic-table td:nth-child(2) { width: 13%; }
          #ea-settings-modal .ea-logic-table th:nth-child(4), #ea-settings-modal .ea-logic-table td:nth-child(4) { width: 8%; text-align: center; }
          @media (max-width: 700px) { #ea-settings-modal .ea-modal-content { width: 98vw; margin-top: 1vh; } #ea-settings-modal .ea-modal-body { padding: .5rem 0; } }
          #emberhold-automation .ea-import-status { opacity: .75; font-size: .85em; }
          #emberhold-automation .ea-settings { border-top: 1px solid currentColor; padding-top: .35rem; }
          #emberhold-automation .ea-settings > details { padding: .2rem 0; }
          #emberhold-automation .ea-status { opacity: .75; font-size: .85em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          @media (max-width: 520px) {
            #emberhold-automation .ea-grid, #emberhold-automation .ea-settings-grid { grid-template-columns: 1fr; }
          }
        `;
        style.textContent = style.textContent.replaceAll('#emberhold-automation', '.ea-embedded-panel');
        document.head.appendChild(style);
      }
      panel = document.createElement('section');
      panel.id = 'emberhold-automation';
      panel.className = 'ea-embedded-panel';
      panel.innerHTML = `<details data-ui-detail="panel"><summary>Emberhold Automation</summary>
        <div class="ea-body">
          <div class="ea-grid">${[
            ['enabled', 'Enabled'], ['jobs', 'Jobs'], ['research', 'Research'],
            ['buildings', 'Buildings'], ['crafting', 'Crafting'], ['power', 'Power'],
            ['diplomacy', 'Diplomacy'], ['expeditions', 'Expeditions'],
            ['combat', 'Combat'], ['wonderStart', 'Start Wonders'], ['wonderHandle', 'Handle Wonders'],
          ].map(([id, label]) => settingInput(id, label)).join('')}</div>
          <div class="ea-status" data-status>Waiting for Emberhold</div>
        </div></details>
        <details data-ui-detail="settings" class="ea-settings"><summary>More settings</summary>
          <details data-ui-category="queues"><summary>Personal queues</summary><div class="ea-queue-settings">
            <label>Build queue <select data-queue-select="build"><option value="">Choose a building…</option>${queueOptions('build')}</select><button type="button" data-queue-add="build">Add</button></label>
            <div data-queue-list="build"></div>
            <label>Research queue <select data-queue-select="research"><option value="">Choose research…</option>${queueOptions('research')}</select><button type="button" data-queue-add="research">Add</button></label>
            <div data-queue-list="research"></div>
            <small>These queues reserve their next item’s ingredients and submit it when affordable. They do not replace Emberhold’s native queues.</small>
          </div></details>
          <details data-ui-category="core"><summary>General</summary><div class="ea-settings-grid">
            ${settingInput('interval', 'Loop delay', 'select')}
            <div class="ea-settings-actions"><button type="button" data-export>Export text</button><button type="button" data-download>Save file</button><button type="button" data-import>Import text</button><input type="file" data-import-file accept=".json,application/json"></div>
            <textarea data-settings-text rows="6" spellcheck="false" placeholder="Paste exported settings JSON here"></textarea><span class="ea-import-status" data-import-status></span>
          </div></details>
          <details data-ui-category="jobs"><summary>Jobs</summary><div class="ea-settings-grid">
            ${settingInput('jobs', 'Automatic job assignment')}
          </div></details>
          <details data-ui-category="research"><summary>Research</summary><div class="ea-settings-grid">
            ${settingInput('research', 'Automatic research')}
          </div></details>
          <details data-ui-category="buildings"><summary>Buildings</summary><div class="ea-settings-grid">
            ${settingInput('buildings', 'Automatic construction')}
          </div></details>
          <details data-ui-category="production"><summary>Production</summary><div class="ea-settings-grid">
            ${settingInput('crafting', 'Automatic crafting')}
          </div></details>
          <details data-ui-category="power"><summary>Power</summary><div class="ea-settings-grid">
            ${settingInput('power', 'Automatic power allocation')}
          </div></details>
          <details data-ui-category="diplomacy"><summary>Diplomacy</summary><div class="ea-settings-grid">
            ${settingInput('diplomacy', 'Automatic diplomacy requests')}
          </div></details>
          <details data-ui-category="expeditions"><summary>Expeditions</summary><div class="ea-settings-grid">
            ${settingInput('expeditions', 'Automatic expeditions')}
          </div></details>
          <details data-ui-category="combat"><summary>Combat</summary><div class="ea-settings-grid">
            ${settingInput('combat', 'Automatic combat', 'checkbox')}
            <small>Combat is disabled by default because it can commit troops and initiate attacks.</small>
          </div></details>
          <details data-ui-category="wonders"><summary>Wonders</summary><div class="ea-settings-grid">
            ${settingInput('wonderStart', 'Start wonders')}${settingInput('wonderHandle', 'Handle wonders')}
            <small>The final Wonder fate remains manual.</small>
          </div></details>
          <details data-ui-category="diagnostics"><summary>Diagnostics</summary><div class="ea-settings-grid">
            <span>Live status is shown above. Shift-click any control to configure conditional logic.</span>
          </div></details>
        </details>`;
      host.appendChild(panel);
      wireSettingInputs(panel);
      wireUiDetails(panel);
      wireQueueControls(panel);
      const text = panel.querySelector('[data-settings-text]');
      panel.querySelector('[data-export]').addEventListener('click', () => {
        text.value = exportSettings();
        text.select();
        navigator.clipboard?.writeText(text.value).catch(() => {});
      });
      panel.querySelector('[data-download]').addEventListener('click', downloadSettings);
      panel.querySelector('[data-import]').addEventListener('click', () => {
        panel.querySelector('[data-import-status]').textContent = importSettings(text.value);
      });
      panel.querySelector('[data-import-file]').addEventListener('change', event => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          text.value = String(reader.result || '');
          panel.querySelector('[data-import-status]').textContent = importSettings(text.value);
        };
        reader.readAsText(file);
      });
      moveDetailedSettings(panel);
    } else if (panel.parentElement !== host) {
      host.appendChild(panel);
      moveDetailedSettings(panel);
    } else {
      moveDetailedSettings(panel);
    }
    return panel;
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
