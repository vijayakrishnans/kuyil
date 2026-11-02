# contracts — architecture

A `turbo-package` component in `packages/contracts`: TypeScript, built by the
turbo pipeline, consumed via workspace references (no publish step — the
repo is the registry).

Changes here fan out: every consumer above is re-planned when this
package changes, so its verify suites gate the blast radius.
