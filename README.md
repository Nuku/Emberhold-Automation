# Emberhold Automation

Configurable userscript automation for [Emberhold](https://nuku.github.io/Emberhold/).

Install [`emberhold_automation.user.js`](https://raw.githubusercontent.com/Nuku/Emberhold-Automation/main/emberhold_automation.user.js) in Tampermonkey or Violentmonkey. The script declares GitHub update metadata, so supported userscript managers can check this repository for new versions automatically.

The automation handles jobs, research, buildings, crafting dependencies, diplomacy, and expeditions. Resources required by queued construction, research, and expeditions are reserved before automation spends or reallocates them. Crafting supplies queued projects and building/expedition dependencies; disabling Crafting disables all automatic crafting. Trials and migration are manual and have no automation controls.

The script uses the page's synchronous `window.emberhold` API. It refreshes state between automation stages, uses current expedition costs, and preserves targeted performers/explorers during ordinary job reassignment. Diplomat pause/resume requires both Jobs and Diplomacy enabled. Event subscriptions are optional.

Priority lists are preferences rather than allowlists: new research, buildings, and ordinary resource-producing jobs are discovered from the game definitions, subject to unlocks and capacity limits. Advanced Science, Instrument Halls, and Experimentalists have explicit priorities. Knowledge workers are preserved during ordinary reassignment and can donate workers in food emergencies. New targeted or non-producing jobs still require dedicated handling; automatic discovery assumes the existing game API and definition schema.

Run the regression checks with `node --test tests/automation.test.cjs`.

Food deficits are handled before queued-project staffing: miners can donate workers even when a queued project still demands Stone. Other jobs with a population-limited capacity are filled before queue-specific staffing. The planner uses the game's net production rate directly.

Performer staffing accounts for crowding, Living Blocks, and conquered trade partners, with a buffer for winter storms and continued morale recovery. It immediately recruits idle villagers or surplus resource workers, preserving food workers, knowledge workers, targeted jobs, and production needed for ongoing consumption. Food shortages take priority. The target remains staffed at maximum morale; at 53 villagers without Living Blocks or conquered towns, it is five performers.

For a real-engine reproduction of the reported winter starvation state, run `node tests/game-integration.cjs <save-export.txt>` with GitHub CLI available. This reads the upstream game source and simulates the save in memory, without changing a live game.
