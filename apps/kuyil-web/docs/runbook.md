# kuyil-web runbook

- **Health:** `GET /healthz` for the app, `GET /v1/social/health` for the API through it.
- **Blank page:** check the browser console for a content security policy error. Scripts and styles must be same-origin files.
- **Sign-in:** stage shows the code on screen. Prod needs a verified mail domain or an OAuth app; see `ai/context/operations.md`.
