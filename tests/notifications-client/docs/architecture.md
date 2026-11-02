# notifications-client-tests — architecture

A `turbo-package` component in `tests/notifications-client`, built and executed by the
turbo pipeline. It consumes its target through the same workspace
packages production code uses, so contract drift fails here first —
before a deploy lane ever runs.
