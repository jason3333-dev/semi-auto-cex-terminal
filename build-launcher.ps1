$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $Root "launcher\SemiAutoCexTerminalLauncher.cs"
$Dist = Join-Path $Root "dist"
$Output = Join-Path $Dist "SemiAutoCexTerminal.exe"
$CscCandidates = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

$Csc = $CscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Csc) {
  throw "csc.exe was not found. Install .NET Framework 4.x developer tools."
}

New-Item -ItemType Directory -Force -Path $Dist | Out-Null
& $Csc /nologo /target:exe /platform:anycpu /optimize+ "/out:$Output" $Source
Write-Host "Built $Output"
