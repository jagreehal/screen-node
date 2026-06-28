# CI TODO

The inherited GitHub Actions workflows were sandbox-node's (Docker integration
tests + container gates) and were removed from the first screen-node commit
because they don't apply and because pushing them needs a `workflow`-scoped
token. Add a screen-node CI workflow (typecheck, build, `pnpm test`, repo gates;
no Docker) with a token that has `workflow` scope:

    gh auth refresh -h github.com -s workflow
