// ==UserScript==
// @name         Emberhold Automation
// @namespace    https://github.com/emberhold
// @version      1.1.0
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

  function affordable(cost, state) {
    return Object.entries(cost || {}).every(([id, amount]) => (state.res[id] || 0) >= amount);
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
    'workbench', 'library', 'monument', 'barracks', 'deepMine', 'deepStore',
    'coalSeam', 'foundry', 'aqueduct', 'shrine', 'amphitheatre', 'workshop',
    'steamPlant', 'dynamo', 'vault', 'factory', 'observatory', 'beacon',
  ];
  const JOB_ORDER = [
    'forager', 'woodcutter', 'miner', 'thinker', 'tinkerer', 'digger',
    'ironminer', 'copperminer', 'astronomer', 'banker', 'diplomat',
  ];

  function autoJobs(state) {
    const defs = definitions().JOBS || {};
    const assignable = JOB_ORDER.filter(id => defs[id] && id !== 'guard' && jobUnlocked(defs[id]));
    if (!assignable.length) return;

    const available = Math.max(0, state.pop - Object.values(state.jobs || {})
      .reduce((sum, n) => sum + (Number(n) || 0), 0));
    if (available > 0) {
      // Keep the first two needs covered, then concentrate workers on the
      // highest unlocked job. The engine rejects unavailable assignments.
      const priority = state.res.food < 40 ? ['forager', 'woodcutter'] :
        state.res.wood < 30 ? ['woodcutter', 'forager'] :
          ['thinker', 'miner', 'woodcutter', 'forager'];
      const target = priority.find(id => assignable.includes(id)) || assignable[0];
      invoke('assign', target, 1);
      return;
    }

    // Move one worker when a store is in danger. This keeps the loop gentle
    // and avoids oscillating every worker on every pass.
    if (state.res.food < 15) {
      const donor = Object.keys(state.jobs || {}).find(id => id !== 'forager' && state.jobs[id] > 0);
      if (donor) { invoke('assign', donor, -1); invoke('assign', 'forager', 1); }
    }
  }

  function autoResearch(state) {
    const defs = definitions().TECHS || [];
    for (const id of RESEARCH_ORDER) {
      const def = defs.find(item => item.id === id);
      if (def && !state.techs[id] && unlocked(def, state) && state.res.knowledge >= def.cost) {
        invoke('research', id);
        return;
      }
    }
  }

  function autoBuildings(state) {
    const defs = definitions().BUILDINGS || [];
    for (const id of BUILD_ORDER) {
      const def = defs.find(item => item.id === id);
      if (!def || state.bld[id] >= def.max || !unlocked(def, state)) continue;
      const cost = typeof api().helpers?.buildingCost === 'function'
        ? api().helpers.buildingCost(def) : def.cost;
      if (craftMissingFor(cost, state)) return;
      if (affordable(cost, state)) {
        invoke('build', id);
        return;
      }
    }
  }

  function craftMissingFor(cost, state, seen = new Set()) {
    const defs = definitions().CRAFTS || [];
    for (const [resource, amount] of Object.entries(cost || {})) {
      if ((state.res[resource] || 0) >= amount) continue;
      const recipe = defs.find(def => def.give?.[resource] && unlocked(def, state));
      if (!recipe || seen.has(recipe.id)) continue;
      const nextSeen = new Set(seen).add(recipe.id);
      const missingInput = Object.entries(recipe.cost || {})
        .find(([input, inputAmount]) => (state.res[input] || 0) < inputAmount);
      if (missingInput && craftMissingFor({ [missingInput[0]]: missingInput[1] }, state, nextSeen)) return true;
      if (!missingInput && affordable(recipe.cost, state)) {
        return invoke('craft', recipe.id);
      }
    }
    return false;
  }

  function autoCraft(state) {
    // Crafting is demand-driven: autoBuildings handles the next build's
    // craftable dependencies. This fallback keeps manually selected recipes
    // moving once their inputs are available without stockpiling everything.
    const defs = definitions().CRAFTS || [];
    const target = defs.find(def => unlocked(def, state) && affordable(def.cost, state) &&
      Object.entries(def.give || {}).some(([id, amount]) =>
        (state.res[id] || 0) < amount));
    if (target) invoke('craft', target.id);
  }

  function autoDiplomacy(state) {
    for (const [id, entry] of Object.entries(state.diplomacy || {})) {
      const request = entry.request;
      if (request && affordable({ [request.res]: request.amount }, state)) {
        invoke('supplyDiplomacyRequest', id);
        return;
      }
    }
  }

  function autoExpeditions(state) {
    const defs = definitions().EXPEDITIONS || [];
    for (const def of defs) {
      if (!state.expeditions[def.id] && (!def.landing || def.landing === state.landing) &&
          state.pop >= def.reqPop && affordable(def.cost, state)) {
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
      if (settings.jobs) autoJobs(state);
      if (settings.research) autoResearch(state);
      if (settings.buildings) autoBuildings(state);
      if (settings.crafting) autoCraft(state);
      if (settings.diplomacy) autoDiplomacy(state);
      if (settings.expeditions) autoExpeditions(state);
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
