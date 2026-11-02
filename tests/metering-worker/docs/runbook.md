# metering-worker-tests — runbook

## How it runs

Planned whenever its target (or this suite) changes; the lane runs the
suite and reports pass/fail. There is nothing to deploy or roll back.

## When it fails

Read the failing assertion in the lane log. Fix the target component or
update the suite WITH the behavior change in the same PR — never merge
around a red verify lane; it is the convergence gate.
