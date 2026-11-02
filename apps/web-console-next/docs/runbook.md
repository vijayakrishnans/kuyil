# web-console-next — runbook

## How it deploys

Merges to `main` converge automatically: CI plans changed components
(`orun plan --changed`) and runs this component's lane via
`orun run --remote-state` with credential-free OIDC auth. The convergence
run is the deployment; the DAG orders this component after everything it
depends on. Failed lanes resume with `gh run rerun --failed`.

## Rollback

Revert the offending commit on `main`; the next convergence applies the
previous desired state. There is no out-of-band mutation to undo — the
repo is the source of truth.

## Verify

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://kuyil-web-console-next-stage.vijayakrishnan12994.workers.dev
curl -s -o /dev/null -w '%{http_code}\n' https://kuyil-web-console-next-prod.vijayakrishnan12994.workers.dev
```

Then probe the edge `/health` too — a green console does not imply a
healthy API.

## Common failures

- **Build lane slow/failing**: console builds are the heaviest in the
  repo; check the lane's build output before suspecting infrastructure.
- **Console up, API calls failing**: verify `api-edge` — the console is
  static assets and survives an edge outage visually.
