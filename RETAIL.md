# MemeMax Orderly Retail Portable Package

Build the Windows portable package:

```powershell
.\build-retail.ps1
```

The build creates:

```text
dist\retail\SemiAutoCexTerminal-win-x64\
dist\retail\SemiAutoCexTerminal-win-x64.zip
```

The package bundles:

- `SemiAutoCexTerminal.exe`
- `runtime\node.exe`
- MemeMax Orderly app files under `app\`
- `README.txt`

Retail session settings are created and read from:

```text
%LOCALAPPDATA%\SemiAutoCexTerminal\.env.session
```

Order lifecycle audit logs are written as UTF-8 JSONL to:

```text
%LOCALAPPDATA%\SemiAutoCexTerminal\logs\order-audit.jsonl
```

Stop the terminal and delete that file, or delete the whole
`%LOCALAPPDATA%\SemiAutoCexTerminal\logs\` directory, to clear local audit logs.
Do not share or package audit logs; they are local runtime data.

First launch copies the MemeMax dry-run template from `app\.env.session.example`.
No live credentials, local `.env.session`, logs, debug images, or `dist` artifacts are included in the ZIP.

Before changing the package from dry-run to testnet or live, complete the smoke and readiness checklist in `docs\validation.md`. Live mode must remain locked unless `.env.session` explicitly includes `LIVE_UNLOCK_PHRASE=I_ACCEPT_LIVE_RISK` after dry-run and testnet validation pass.

## Release checklist

1. Start from a clean workspace and verify no local session or config files are staged:

```powershell
git status --short
```

2. Run the Node validation:

```powershell
node --test tests/*.test.js
node --check src/server.js
node --check src/audit-log.js
node --check src/account-stream-normalizers.js
node --check src/live-risk.js
node --check src/exchanges/binance-usdm.js
node --check src/exchanges/mememax-orderly.js
node --check src/exchanges/registry.js
node --check src/exchanges/types.js
node --check public/app.js
```

3. Build the portable Windows retail package:

```powershell
.\build-retail.ps1
```

`build-retail.ps1` runs the package smoke check automatically after creating the folder and ZIP.

4. Re-run the smoke check manually before distribution if the package was moved or rebuilt elsewhere:

```powershell
.\check-retail-package.ps1 -PackagePath .\dist\retail\SemiAutoCexTerminal-win-x64
```

The check verifies the launcher, bundled Node runtime, app files, README, `.env` examples, and ZIP contents. It fails if the package contains `.env`, `.env.session`, `local_config`, logs, screenshots/debug images, `node_modules`, test folders, coverage, nested `dist`, ZIPs, or obvious API key/secret assignments.

5. Launch the package once from `dist\retail\SemiAutoCexTerminal-win-x64\SemiAutoCexTerminal.exe`.

Confirm that the launcher creates session settings only here:

```text
%LOCALAPPDATA%\SemiAutoCexTerminal\.env.session
```

Do not distribute from a folder that contains real `.env.session`, API keys, `local_config`, logs, build artifacts, or screenshots with sensitive data. Distribute only:

```text
dist\retail\SemiAutoCexTerminal-win-x64.zip
```
