---
"@jagreehal/screen-node": patch
---

docs and CLI clarity: rework the README to show how screen works with real
before/after terminal output (clean pass, blocked finding, next-good-version
substitution), document auditing an existing package.json and the maintenance
and CI commands, and add the screen-audit skill. Drop the removed `build` and
`shell` container commands from the unknown-command help, and strip em dashes
from docs/reference.md per the no-em-dash convention.
