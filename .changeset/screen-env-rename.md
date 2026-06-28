---
"@jagreehal/screen-node": major
---

Finish the screen rebrand: rename the remaining internal env vars to the
`SCREEN_*` prefix (`SCREEN_LOG`, `SCREEN_PM_BIN`, `SCREEN_NPM_REGISTRY`, etc.)
and on-disk names to `screen.advisories.json`, `.screen-audit-ignore`, the
`.screen` agent dir, and the `screen-node` XDG dir. The integration golden tests
were updated to the container-free, `screen`-branded surface (removed-feature
tests deleted) and now pass.
