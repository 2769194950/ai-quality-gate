# Repository selection notes

The paths below exist **only** as selector inputs for `qgate preview`. Every one
of them must be excluded from `selection.included`, which is exactly what
`REQ-QUALITY-GATE-012` (and the `no-secret-paths` policy check) asserts:

| path | expected exclusion reason |
|---|---|
| `.env` | `secret_path` (`secret-env`) |
| `.env.local` | `secret_path` (`secret-env`) |
| `secrets/payments.pem` | `secret_path` (`secret-pem`) |
| `config/service.key` | `secret_path` (`secret-key`) |
| `node_modules/left-pad/index.js` | `default_excluded_path` (`node_modules`) |
| `assets/logo.png` | `binary` |
| `bundle.zip` | `binary` |

None of these files is referenced by any check and none of them carries a real
credential: they are synthetic fixtures for the deterministic selection tests.
