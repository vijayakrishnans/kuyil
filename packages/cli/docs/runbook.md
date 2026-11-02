# cli — runbook

## How it ships

Nothing deploys from a package directly: consumers rebuild against it in
the same convergence that lands the change. The package's (and its
consumers') verify lanes are the gate.

## When its lane fails

Build/type errors surface in the lane log. Fix in the same PR as the
consuming change — partial merges leave consumers red.
