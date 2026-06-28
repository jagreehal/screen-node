# sandbox docs site

The documentation + landing site for `@jagreehal/sandbox-node`, built with [Astro](https://astro.build) + [Starlight](https://starlight.astro.build). Deployed to GitHub Pages by `.github/workflows/docs.yml`.

This is a standalone pnpm project (its own `pnpm-workspace.yaml`), separate from the repo's package.

```bash
cd site
pnpm install
pnpm dev       # local dev server
pnpm build     # static build to dist/
pnpm preview   # preview the build
```

Design direction lives in `../.impeccable.md`. Content is in `src/content/docs/`; the splash hero and landing sections are `src/components/Hero.astro` and `Landing.astro`; theming is `src/styles/theme.css`.
