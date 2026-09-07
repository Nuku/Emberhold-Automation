// ==UserScript==
// @name         Emberhold Automation
// @namespace    https://github.com/emberhold
// @version      1.25.9
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
    crafting: true,
    diplomacy: true,
    expeditions: true,
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

  function queuedDemand() {
    return api().helpers?.queueDemand?.() || {};
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

  // The order is intentionally explicit: it is easy to adjust for a different
  // strategy without changing the controller or Emberhold itself.
  const RESEARCH_ORDER = [
    'stoneWorking', 'writing', 'craftsmanship', 'masonry', 'copperProspecting',
    'currency', 'guards', 'leatherArmor', 'deepMining', 'seamMining',
    'metallurgy', 'weaponry', 'banking', 'diplomacy', 'civics', 'council',
    'machineryTech', 'hydraulics', 'weaponEfficiency', 'electricalEngineering',
    'astronomy', 'optics', 'aphrodisiac', 'hospital',
  ];
  const BUILD_ORDER = [
    'hut', 'storehouse', 'foragerLodge', 'lumberYard', 'quarry', 'stoneWorks',
    'workbench', 'library', 'monument', 'barracks', 'trainingYard', 'hospital', 'deepMine', 'deepStore',
    'coalSeam', 'forge', 'aqueduct', 'shrine', 'amphitheatre', 'workshop',
    'steamPlant', 'dynamo', 'vault', 'factory', 'observatory', 'beacon',
  ];
  const JOB_ORDER = [
    'forager', 'woodcutter', 'miner', 'thinker', 'tinkerer', 'digger',
    'ironminer', 'copperminer', 'astronomer', 'banker', 'diplomat',
  ];

  function autoMorale(state) {
    const performer = definitions().JOBS?.performer;
    if (!performer || !jobUnlocked(performer)) return false;
    const performers = Number(state.jobs?.performer || 0);
    const available = availableWorkers(state);
    if ((state.morale || 0) < 100 && available > 0) {
      invoke('assignPerformer', 1);
      return Number(api().getState()?.jobs?.performer || 0) > performers;
    }
    if ((state.morale || 0) >= 100 && performers > 1) {
      invoke('assignPerformer', -1);
      return Number(api().getState()?.jobs?.performer || 0) < performers;
    }
    return false;
  }

  function autoJobs(state, demand) {
    const defs = definitions().JOBS || {};
    const effectiveJobRate = api().helpers?.jobProduction;
    const assignable = JOB_ORDER.filter(id => defs[id] && id !== 'guard' && jobUnlocked(defs[id]) &&
      (!effectiveJobRate || effectiveJobRate(id) > 0));

    const count = id => Number(state.jobs?.[id] || 0);
    const stock = id => Math.max(0, (state.res[id] || 0) - (demand[id] || 0));
    const minimums = [
      ['forager', 1],
      ['woodcutter', 1],
      ['miner', state.pop >= 6 ? 1 : 0],
      ['thinker', state.pop >= 8 ? 1 : 0],
    ];
    const rates = api().helpers?.production?.(1) || {};
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
    // Keep the workers whose output offsets consumption. A positive net rate
    // with the current workforce does not mean the whole workforce is surplus.
    const sustainingMinimum = id => {
      const resource = defs[id]?.res;
      const perWorker = effectiveJobRate?.(id);
      if (!(perWorker > 0) || !Number.isFinite(rates[resource])) {
        return id === 'forager' ? count(id) : 0;
      }
      return Math.max(0, Math.min(count(id),
        Math.ceil(count(id) - rates[resource] / perWorker - 1e-9)));
    };
    const minimum = id => Math.max(sustainingMinimum(id), id === 'forager' ? 1 :
      (!needsWork(id) || (effectiveJobRate && effectiveJobRate(id) <= 0)
        ? 0 : minimums.find(item => item[0] === id)?.[1] || 0));
    // An empty food store is an emergency. Do not preserve a calculated
    // sustaining floor for another production job while villagers are
    // starving; food must be able to reclaim those workers first.
    const foodEmergency = stock('food') <= 0 || (rates.food || 0) < 0;
    const donorMinimum = id => foodEmergency && id !== 'forager' ? 0 : minimum(id);
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
    if (!assignable.length) return;

    const available = availableWorkers(state);
    const perWorker = id => Math.max(0, Number(effectiveJobRate?.(id) || defs[id]?.base || 0));
    const neededWorkers = (id, resource, target) => {
      const rate = perWorker(id);
      if (!rate) return 0;
      const deficit = Math.max(0, target - stock(resource));
      const shortage = Math.max(0, -(rates[resource] || 0));
      return Math.max(deficit ? Math.ceil(deficit / rate) : 0,
        shortage ? Math.ceil(shortage / rate) : 0);
    };
    const planned = new Map();
    for (const [id, resource, target] of [...demandNeeds, ...needs, ...specialistNeeds]) {
      if (!assignable.includes(id)) continue;
      const amount = neededWorkers(id, resource, target);
      if (amount) planned.set(id, Math.max(planned.get(id) || 0, amount));
    }
    for (const [id, minimumCount] of minimums) {
      if (minimumCount > 0 && assignable.includes(id) && count(id) < minimum(id)) {
        planned.set(id, Math.max(planned.get(id) || 0, minimum(id) - count(id)));
      }
    }

    const donors = Object.keys(state.jobs || {})
      .filter(id => defs[id] && !defs[id].targeted && id !== 'guard' && !planned.has(id) && count(id) > donorMinimum(id))
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
    if (!planned.size) {
      const donor = donors[0];
      if (donor) {
        const targetCount = count(donor) - 1;
        if (api().actions?.setJob && invoke('setJob', donor, targetCount)) return;
        invoke('assign', donor, -1);
      }
    }
  }

  function autoResearch(state, demand) {
    const defs = definitions().TECHS || [];
    for (const id of RESEARCH_ORDER) {
      if (state.queues?.research?.some(entry => entry.id === id)) continue;
      const def = defs.find(item => item.id === id);
      if (def && !state.techs[id] && unlocked(def, state) &&
          affordable({ knowledge: def.cost }, state, demand)) {
        if (invoke('research', id)) return;
      }
    }
  }

  function autoBuildings(state, demand) {
    const defs = definitions().BUILDINGS || [];
    for (const id of BUILD_ORDER) {
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

  function automationStep() {
    if (busy || !settings.enabled || !api()?.getState) return;
    busy = true;
    try {
      if (!snapshot()) return;
      lastAction = 'Scanning Emberhold';
      for (const [setting, step] of [
        ['jobs', autoMorale], ['jobs', autoJobs], ['research', autoResearch],
        ['buildings', autoBuildings], ['crafting', autoCraft],
        ['diplomacy', autoDiplomacy], ['expeditions', autoExpeditions],
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
        ['expeditions', 'Expeditions'],
      ].map(([id, label]) => `<label><input data-setting="${id}" type="checkbox"> ${label}</label>`).join('')}</div>
      <label>Loop delay <select data-setting="interval"><option value="500">0.5s</option><option value="1000">1s</option><option value="2000">2s</option><option value="5000">5s</option></select></label>
      <div class="ea-status" data-status>Waiting for Emberhold</div></div>`;
    document.body.appendChild(panel);
    const style = document.createElement('style');
    style.textContent = '#emberhold-automation{position:fixed;right:1rem;bottom:1rem;z-index:20;background:#211810;color:#f2d49a;border:1px solid #8d6739;padding:.55rem;max-width:18rem;font:13px sans-serif;box-shadow:0 4px 18px #0008}#emberhold-automation summary{cursor:pointer;font-weight:bold}.ea-body{display:grid;gap:.45rem;padding-top:.5rem}.ea-grid{display:grid;grid-template-columns:1fr 1fr;gap:.2rem .7rem}.ea-status{color:#c9a86b;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
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
    if (status) status.textContent = `${lastAction} · day ${Number.isFinite(current?.day) ? Math.floor(current.day) : 'unknown'}`;
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
