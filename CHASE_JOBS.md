# Chase Job Reliability

## Persistence decision

Chase jobs are intentionally kept in process memory and are not persisted across restarts.

A chase job owns live timers, order ids, rate-limit slots, and private-stream freshness assumptions. Resuming that cancel/replace loop after a process restart could cancel or replace an order without the operator first seeing the current exchange state. On restart, the terminal should reload open orders and positions from the exchange, then the operator can start a new chase from fresh state.

Job API snapshots expose `state`, `isTerminal`, `terminalReason`, fill progress, and rate-gate telemetry so failures can be diagnosed without persisting the job control loop.
