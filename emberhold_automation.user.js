// ==UserScript==
// @name         Emberhold Automation
// @namespace    https://github.com/emberhold
// @version      1.17.0
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
    trials: false,
    migration: false,
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
    if (!settings.enabled || !api()?.actions?.[name]) return false;
    api().actions[name](...args);
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

  function autoJobs(state, demand) {
    const defs = definitions().JOBS || {};
    const effectiveJobRate = api().helpers?.jobProduction;
    const assignable = JOB_ORDER.filter(id => defs[id] && id !== 'guard' && jobUnlocked(defs[id]) &&
      (!effectiveJobRate || effectiveJobRate(id) > 0));
    if (!assignable.length) return;

    const count = id => Number(state.jobs?.[id] || 0);
    const stock = id => Math.max(0, (state.res[id] || 0) - (demand[id] || 0));
    const minimums = [
      ['forager', 1],
      ['woodcutter', 1],
      ['miner', state.pop >= 6 ? 1 : 0],
      ['thinker', state.pop >= 8 ? 1 : 0],
    ];
    const rates = api().helpers?.production?.(1) || {};
    const capacityOf = api().helpers?.capacityOf;
    const needsWork = id => {
      const resource = defs[id]?.res;
      if (!resource) return true;
      const full = typeof capacityOf === 'function' && Number.isFinite(capacityOf(resource)) &&
        (state.res[resource] || 0) >= capacityOf(resource) - 0.001;
      return !full || (demand[resource] || 0) > 0 || (rates[resource] || 0) < 0;
    };
    const minimum = id => !needsWork(id) || (effectiveJobRate && effectiveJobRate(id) <= 0)
      ? 0 : minimums.find(item => item[0] === id)?.[1] || 0;
    const needs = [
      ['forager', 'food', 60],
      ['woodcutter', 'wood', (demand.wood || 0) + 40],
      ['miner', 'stone', (demand.stone || 0) + 20],
      ['thinker', 'knowledge', (demand.knowledge || 0) + 100],
    ];
    const reserve = resource => resource === 'food' ? 60 : resource === 'wood' ? 40 :
      resource === 'stone' ? 20 : resource === 'knowledge' ? 100 : 10;
    const specialistNeeds = assignable
      .filter(id => defs[id].res && Number(defs[id].base) > 0 &&
        !needs.some(([job]) => job === id))
      .map(id => [id, defs[id].res, reserve(defs[id].res)]);
    const demandNeeds = assignable
      .filter(id => defs[id].res && Number(defs[id].base) > 0 && (demand[defs[id].res] || 0) > 0)
      .map(id => [id, defs[id].res,
        Math.max(reserve(defs[id].res), Math.ceil((demand[defs[id].res] || 0) * 0.10))]);
    const need = [...demandNeeds, ...needs, ...specialistNeeds].find(([job, resource, target]) => assignable.includes(job) &&
      (stock(resource) < target || (rates[resource] || 0) < 0));
    const targetForNeed = need && need[0];

    if (assignable.includes('diplomat') && api()?.actions?.assignDiplomat) {
      for (const [id, count] of Object.entries(state.diplomats || {})) {
        if (count > 0 && state.diplomacy?.[id]?.disposition >= 100) {
          pausedDiplomats[id] = (pausedDiplomats[id] || 0) + 1;
          invoke('assignDiplomat', id, -1);
          return;
        }
      }

      const assigned = Object.values(state.jobs || {})
        .reduce((sum, n) => sum + (Number(n) || 0), 0) +
        Object.values(state.diplomats || {})
          .reduce((sum, n) => sum + (Number(n) || 0), 0);
      const available = Math.max(0, state.pop - assigned);
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

    const available = Math.max(0, state.pop - Object.values(state.jobs || {})
      .reduce((sum, n) => sum + (Number(n) || 0), 0));
    const productionJobs = assignable.filter(id => defs[id].res && Number(defs[id].base) > 0 &&
      (!effectiveJobRate || effectiveJobRate(id) > 0) && needsWork(id));
    const balancedJob = productionJobs.sort((a, b) => count(a) - count(b))[0];
    const underMinimum = minimums.find(([id, minimum]) =>
      minimum > 0 && assignable.includes(id) && needsWork(id) && count(id) < minimum);
    const target = underMinimum?.[0] || targetForNeed || balancedJob;
    const reclaimable = Object.keys(state.jobs || {}).filter(id => {
      const zeroed = effectiveJobRate && defs[id]?.res && Number(defs[id].base) > 0 && effectiveJobRate(id) <= 0;
      return id !== target && count(id) > minimum(id) && (zeroed || !needsWork(id));
    });
    if (reclaimable.length) {
      for (const donor of reclaimable) {
        const amount = Math.max(0, count(donor) - minimum(donor));
        for (let i = 0; i < amount; i++) invoke('assign', donor, -1);
      }
      return;
    }
    if (available > 0) {
      if (target) {
        const assignments = need ? available : 1;
        for (let i = 0; i < assignments; i++) invoke('assign', target, 1);
      }
      return;
    }

    // Reallocate one worker when a target is unmet, or release surplus workers
    // when all stores have enough coverage. Never take a minimum job below its
    // floor, and prefer removing the largest surplus first.
    const donors = Object.keys(state.jobs || {})
      .filter(id => id !== target && count(id) > minimum(id))
      .sort((a, b) => {
        const aZeroed = effectiveJobRate && defs[a]?.res && Number(defs[a].base) > 0 && effectiveJobRate(a) <= 0;
        const bZeroed = effectiveJobRate && defs[b]?.res && Number(defs[b].base) > 0 && effectiveJobRate(b) <= 0;
        const surplus = id => {
          const resource = defs[id]?.res;
          return resource ? Math.max(0, (state.res[resource] || 0) - (demand[resource] || 0)) - reserve(resource) : 0;
        };
        const aDemanded = defs[a]?.res && (demand[defs[a].res] || 0) > 0;
        const bDemanded = defs[b]?.res && (demand[defs[b].res] || 0) > 0;
        return Number(bZeroed) - Number(aZeroed) || Number(aDemanded) - Number(bDemanded) ||
          surplus(b) - surplus(a) || (count(b) - minimum(b)) - (count(a) - minimum(a));
      });
    const donor = donors[0];
    if (donor && target) {
      invoke('assign', donor, -1);
      invoke('assign', target, 1);
    }
  }

  function autoResearch(state, demand) {
    const defs = definitions().TECHS || [];
    for (const id of RESEARCH_ORDER) {
      const def = defs.find(item => item.id === id);
      if (def && !state.techs[id] && unlocked(def, state) &&
          affordable({ knowledge: def.cost }, state, demand)) {
        invoke('research', id);
        return;
      }
    }
  }

  function autoBuildings(state, demand) {
    const defs = definitions().BUILDINGS || [];
    for (const id of BUILD_ORDER) {
      const def = defs.find(item => item.id === id);
      if (!def || state.bld[id] >= def.max || !unlocked(def, state)) continue;
      const canBuild = api().helpers?.canBuild;
      if (canBuild ? !canBuild(id) :
        (state.trial?.id === 'overflow' && ['storehouse', 'deepStore', 'vault'].includes(id))) continue;
      const cost = typeof api().helpers?.buildingCost === 'function'
        ? api().helpers.buildingCost(def) : def.cost;
      if (craftMissingFor(cost, state, demand)) return;
      if (affordable(cost, state, demand)) {
        invoke('build', id);
        return;
      }
    }
  }

  function craftMissingFor(cost, state, demand, seen = new Set()) {
    const defs = definitions().CRAFTS || [];
    for (const [resource, amount] of Object.entries(cost || {})) {
      if (Math.max(0, (state.res[resource] || 0) - (demand[resource] || 0)) >= amount) continue;
      const recipe = defs.find(def => def.give?.[resource] && unlocked(def, state));
      if (!recipe || seen.has(recipe.id)) continue;
      const nextSeen = new Set(seen).add(recipe.id);
      const missingInput = Object.entries(recipe.cost || {})
        .find(([input, inputAmount]) => Math.max(0, (state.res[input] || 0) - (demand[input] || 0)) < inputAmount);
      if (missingInput && craftMissingFor({ [missingInput[0]]: missingInput[1] }, state, demand, nextSeen)) return true;
      if (!missingInput && affordable(recipe.cost, state, demand)) {
        return invoke('craft', recipe.id);
      }
    }
    return false;
  }

  function autoCraft(state, demand) {
    // Crafting is demand-driven: autoBuildings handles the next build's
    // craftable dependencies. This fallback keeps manually selected recipes
    // moving once their inputs are available without stockpiling everything.
    const defs = definitions().CRAFTS || [];
    const target = defs.find(def => unlocked(def, state) && affordable(def.cost, state, demand) &&
      Object.entries(def.give || {}).some(([id, amount]) =>
        (state.res[id] || 0) < amount));
    if (target) invoke('craft', target.id);
  }

  function autoDiplomacy(state, demand) {
    for (const [id, entry] of Object.entries(state.diplomacy || {})) {
      const request = entry.request;
      if (entry.disposition >= 100) continue;
      if (request && affordable({ [request.res]: request.amount }, state, demand)) {
        invoke('supplyDiplomacyRequest', id);
        return;
      }
    }
  }

  function autoExpeditions(state, demand) {
    const defs = definitions().EXPEDITIONS || [];
    for (const def of defs) {
      const queued = (state.queues?.expedition || []).some(entry => entry.id === def.id);
      if (!state.expeditions[def.id] && !queued && (!def.landing || def.landing === state.landing) &&
          state.pop >= def.reqPop && affordable(def.cost, state, demand)) {
        invoke('expedition', def.id);
        return;
      }
    }
  }

  function automationStep() {
    if (busy || !settings.enabled || !api()?.getState) return;
    busy = true;
    try {
      const state = snapshot();
      if (!state) return;
      const demand = queuedDemand();
      if (settings.jobs) autoJobs(state, demand);
      if (settings.research) autoResearch(state, demand);
      if (settings.buildings) autoBuildings(state, demand);
      if (settings.crafting) autoCraft(state, demand);
      if (settings.diplomacy) autoDiplomacy(state, demand);
      if (settings.expeditions) autoExpeditions(state, demand);
      // Trials and migration are deliberately opt-in and strategy-specific.
      updatePanel(state);
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
        ['expeditions', 'Expeditions'], ['trials', 'Trials'], ['migration', 'Migration'],
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
    if (status) status.textContent = `${lastAction} · day ${Math.floor(state.day)}`;
  }

  function restart() {
    if (timer) clearInterval(timer);
    timer = setInterval(automationStep, Math.max(250, settings.interval));
  }

  function boot() {
    if (!api()) return setTimeout(boot, 250);
    makePanel();
    api().subscribe(updatePanel);
    restart();
    automationStep();
  }

  boot();
})();
