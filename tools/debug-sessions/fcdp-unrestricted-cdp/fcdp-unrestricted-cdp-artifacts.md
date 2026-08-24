# fcdp unrestricted CDP artifacts

- `tools/repro/fcdp-unrestricted-domains/run.sh`: isolated port transport matrix.
- `tools/repro/fcdp-unrestricted-domains/run-pipe.sh`: isolated pipe transport matrix.
- `tools/repro/fcdp-unrestricted-domains/run-headless-shell.sh`: pinned Chrome for
  Testing headless-shell matrix.
- `tools/repro/fcdp-unrestricted-domains/run-chromeos.sh`: pinned Linux ChromiumOS
  Full matrix.
- `tools/repro/fcdp-unrestricted-domains/run-all.sh`: merged denominator and exit gate.
- `tools/repro/fcdp-unrestricted-domains/probe.py`: controlled 30-domain probes.
- `tools/repro/fcdp-unrestricted-domains/merge.py`: honest transport union.
- `/tmp/fcdp-domain-union.json`: verified Chrome 151 output (28/30).
- `/tmp/fcdp-canary-pipe-matrix.json`: verified official Canary 154 headless-shell
  output; adds `HeadlessExperimental` to the cross-runtime union (29/30).
- `/tmp/fcdp-domain-matrix-30.json`: verified four-runtime union (30/30), with
  `SmartCardEmulation` dispatched successfully by ChromiumOS snapshot 1684555.
