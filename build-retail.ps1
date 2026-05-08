$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$PackageName = "SemiAutoCexTerminal-win-x64"
$RetailRoot = Join-Path $Root "dist\retail"
$PackageDir = Join-Path $RetailRoot $PackageName
$ZipPath = Join-Path $RetailRoot "$PackageName.zip"

function Resolve-NodeExe {
  $candidates = @(
    (Join-Path $Root "runtime\node.exe"),
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
  )

  $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($pathNode) {
    $candidates += $pathNode.Source
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return $candidate
    }
  }

  throw "node.exe was not found. Install Node.js 20+ or place node.exe in runtime\node.exe."
}

& (Join-Path $Root "build-launcher.ps1")

if (Test-Path -LiteralPath $PackageDir) {
  Remove-Item -LiteralPath $PackageDir -Recurse -Force
}
if (Test-Path -LiteralPath $ZipPath) {
  Remove-Item -LiteralPath $ZipPath -Force
}

New-Item -ItemType Directory -Force -Path $PackageDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PackageDir "app") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PackageDir "runtime") | Out-Null

Copy-Item -LiteralPath (Join-Path $Root "dist\SemiAutoCexTerminal.exe") -Destination (Join-Path $PackageDir "SemiAutoCexTerminal.exe")
Copy-Item -LiteralPath (Resolve-NodeExe) -Destination (Join-Path $PackageDir "runtime\node.exe")

$appDir = Join-Path $PackageDir "app"
Copy-Item -LiteralPath (Join-Path $Root "src") -Destination $appDir -Recurse
Copy-Item -LiteralPath (Join-Path $Root "public") -Destination $appDir -Recurse
Copy-Item -LiteralPath (Join-Path $Root "package.json") -Destination $appDir
Copy-Item -LiteralPath (Join-Path $Root ".env.example") -Destination $appDir
Copy-Item -LiteralPath (Join-Path $Root ".env.session.example") -Destination $appDir
Copy-Item -LiteralPath (Join-Path $Root "README.md") -Destination $appDir

$readme = @"
MemeMax Orderly Semi-Auto Terminal
==================================

1. Run SemiAutoCexTerminal.exe.
2. The local server starts only while this launcher window is open.
3. The browser opens http://127.0.0.1:8787/ automatically.
4. Session settings are stored outside this folder:
   %LOCALAPPDATA%\SemiAutoCexTerminal\.env.session
5. First launch creates a dry-run template. Edit that file, then restart.

Safety defaults:
- SESSION_EXCHANGE_ID=mememax-orderly
- TRADING_MODE=dry-run
- No API credentials are bundled.
- This package does not include .env.session, logs, debug images, or build artifacts.

To uninstall, close the launcher and delete this folder.
To remove local settings too, delete:
%LOCALAPPDATA%\SemiAutoCexTerminal
"@
Set-Content -LiteralPath (Join-Path $PackageDir "README.txt") -Value $readme -Encoding UTF8

Compress-Archive -LiteralPath $PackageDir -DestinationPath $ZipPath -Force

Write-Host "Built retail package: $PackageDir"
Write-Host "Built retail zip: $ZipPath"
