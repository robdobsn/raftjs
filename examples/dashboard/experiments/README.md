# Dashboard experiments

Bench experiments that use the RaftJS example dashboard as the controller: the dashboard
talks to an Axiom over its normal Raft connection for measurement, and directly to USB bench
instruments (via WebHID / Web Serial) for stimulus.

| Experiment | Plan | Status |
|---|---|---|
| Diode characterisation with a FNIRSI DPS-150 + Axiom/VCP (BJT/FET deferred) | [dut-characterisation-plan.md](dut-characterisation-plan.md) | plan, 2026-09-16 |

Conventions:

- One sub-folder or plan file per experiment. Result files (JSON/CSV exports) are **not**
  committed here; keep them alongside the DUT notes wherever bench data lives.
- Dashboard code that experiments need lives under `src/instruments/` (drivers for bench
  instruments) and `src/experiments/` (sweep engine, circuit definitions, panels). The plan
  for each experiment says what it adds there.
