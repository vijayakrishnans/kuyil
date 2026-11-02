# web-console-next — architecture

A `cloudflare-workers-assets-turbo` component: the Next.js app in `apps/web-console-next` builds to
static assets plus a thin Worker runtime, deployed per environment.

- All data access goes through the API edge — the console holds no
  credentials and no direct data-plane access.
- Environment selection (stage/prod edge URL) is wired at build/deploy
  time by the lane; the console is static after that.
- Being assets-first, the console can be "up" while the API behind it is
  degraded — always verify the edge separately.
