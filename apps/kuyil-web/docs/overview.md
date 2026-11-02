# kuyil-web

Kuyil's public app: a Worker that serves static files from `public/` and passes `/v1/*` to `api-edge` over a service binding, so the browser talks to one origin.

Modules load in order from `public/js/main.js`: `core` (API, DOM, routing), `timeline`, `feeds`, `wallet`, `trust`. Each adds its routes and post actions to the shared `K` registry.
