$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$Candidates = @()

if (Test-Path -LiteralPath $BundledNode) {
  $Candidates += $BundledNode
}

$PathNode = Get-Command node -ErrorAction SilentlyContinue
if ($PathNode) {
  $Candidates += $PathNode.Source
}

$Node = $null
foreach ($Candidate in $Candidates) {
  try {
    & $Candidate --version *> $null
    $Node = $Candidate
    break
  } catch {
    continue
  }
}

if (-not $Node) {
  throw "Node.js 20+ was not found. Install Node.js or use the Codex bundled runtime."
}

Set-Location -LiteralPath $Root
& $Node src/server.js

