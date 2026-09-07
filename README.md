# Emberhold Automation

Configurable userscript automation for [Emberhold](https://nuku.github.io/Emberhold/).

Install [`emberhold_automation.user.js`](https://raw.githubusercontent.com/Nuku/Emberhold-Automation/main/emberhold_automation.user.js) in Tampermonkey or Violentmonkey. The script declares GitHub update metadata, so supported userscript managers can check this repository for new versions automatically.

The automation handles jobs, research, buildings, crafting dependencies, diplomacy, and expeditions. Resources required by queued construction, research, and expeditions are reserved before automation spends or reallocates them. Crafting supplies queued projects and building/expedition dependencies; disabling Crafting disables all automatic crafting. Trials and migration are manual and have no automation controls.

The script uses the page's synchronous `window.emberhold` API. It refreshes state between automation stages, uses current expedition costs, and preserves targeted performers/explorers during ordinary job reassignment. Diplomat pause/resume requires both Jobs and Diplomacy enabled. Event subscriptions are optional.

Run the regression checks with `node --test tests/automation.test.cjs`.

Food deficits are handled before queued-project staffing: miners can donate workers even when a queued project still demands Stone. The planner uses the game's net production rate directly.

For a real-engine reproduction of the reported winter starvation state, run `node tests/game-integration.cjs <save-export.txt>` with GitHub CLI available. This reads the upstream game source and simulates the save in memory, without changing a live game.
