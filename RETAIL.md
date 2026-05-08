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

First launch copies the MemeMax dry-run template from `app\.env.session.example`.
No live credentials, local `.env.session`, logs, debug images, or `dist` artifacts are included in the ZIP.
