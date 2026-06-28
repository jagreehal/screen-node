import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';

// GitHub Pages: served at https://jagreehal.github.io/sandbox-node/.
export default defineConfig({
  site: 'https://jagreehal.github.io',
  base: '/sandbox-node',
  integrations: [
    // Must come BEFORE starlight so its rehype pass turns ```mermaid blocks into diagrams.
    // autoTheme tracks Starlight's light/dark toggle.
    mermaid({ autoTheme: true }),
    starlight({
      title: 'sandbox',
      description:
        'Put sandbox in front of npm/pnpm/yarn/bun. Install scripts run in a throwaway container — no SSH keys, no npm token, no cloud creds, registry-only network.',
      favicon: '/favicon.svg',
      // Use the content 404.md as the only /404 route (avoids the [...slug] vs /404 conflict).
      disable404Route: true,
      components: {
        Hero: './src/components/Hero.astro',
      },
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/jagreehal/sandbox-node' }],
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400..600&family=Public+Sans:ital,wght@0,400..700;1,400&family=Schibsted+Grotesk:wght@400..900&display=swap',
          },
        },
      ],
      customCss: ['./src/styles/theme.css'],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Quickstart', slug: 'quickstart' },
            { label: 'How it works', slug: 'how-it-works' },
            { label: "What's protected", slug: 'security-model' },
          ],
        },
        {
          label: 'Using sandbox',
          items: [
            { label: 'Commands', slug: 'commands' },
            { label: 'Configuration', slug: 'configuration' },
          ],
        },
        {
          label: 'Workflows',
          items: [
            { label: 'Vet a package before installing', slug: 'vetting' },
            { label: 'Gate dependencies in CI', slug: 'ci' },
            { label: 'Isolate a coding agent', slug: 'agent-isolation' },
          ],
        },
      ],
    }),
  ],
});
