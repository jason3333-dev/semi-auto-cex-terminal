param(
  [string]$PackagePath = "",
  [string]$ZipPath = "",
  [switch]$SkipZip
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$DefaultPackagePath = Join-Path $Root "dist\retail\SemiAutoCexTerminal-win-x64"

if (-not $PackagePath) {
  $PackagePath = $DefaultPackagePath
}

$Failures = New-Object System.Collections.Generic.List[string]

function Add-Failure {
  param([string]$Message)
  $script:Failures.Add($Message) | Out-Null
}

function Get-RelativePath {
  param(
    [string]$BasePath,
    [string]$ChildPath
  )

  $base = [System.IO.Path]::GetFullPath($BasePath).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $child = [System.IO.Path]::GetFullPath($ChildPath)
  $baseUri = [System.Uri]::new($base + [System.IO.Path]::DirectorySeparatorChar)
  $childUri = [System.Uri]::new($child)
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($childUri).ToString()).Replace("/", "\")
}

function Resolve-PackageRoot {
  param([string]$Path)

  $expectedExe = Join-Path $Path "SemiAutoCexTerminal.exe"
  if (Test-Path -LiteralPath $expectedExe) {
    return $Path
  }

  $children = @(Get-ChildItem -LiteralPath $Path -Directory -Force)
  foreach ($child in $children) {
    $childExe = Join-Path $child.FullName "SemiAutoCexTerminal.exe"
    if (Test-Path -LiteralPath $childExe) {
      return $child.FullName
    }
  }

  return $Path
}

function Test-ExpectedFiles {
  param(
    [string]$PackageRoot,
    [string]$Label
  )

  $expectedFiles = @(
    "SemiAutoCexTerminal.exe",
    "runtime\node.exe",
    "app\src\server.js",
    "app\public\index.html",
    "app\public\app.js",
    "app\public\styles.css",
    "app\package.json",
    "app\.env.example",
    "app\.env.session.example",
    "app\README.md",
    "README.txt"
  )

  foreach ($relativePath in $expectedFiles) {
    $path = Join-Path $PackageRoot $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      Add-Failure "$Label missing expected file: $relativePath"
    }
  }
}

function Test-ForbiddenPaths {
  param(
    [string]$PackageRoot,
    [string]$Label
  )

  $forbiddenDirectories = @(".git", "coverage", "dist", "logs", "node_modules", "screenshots", "tests")
  $forbiddenExactFiles = @(".env", ".env.session")
  $forbiddenFileGlobs = @(
    "*.log",
    "*.pdb",
    "*.tmp",
    "*.bak",
    "*.zip",
    "chart-debug*.png",
    "screenshot*.*",
    "screen-shot*.*"
  )

  foreach ($item in Get-ChildItem -LiteralPath $PackageRoot -Recurse -Force) {
    $relativePath = Get-RelativePath $PackageRoot $item.FullName
    $segments = $relativePath -split "[\\/]+"

    if ($segments | Where-Object { $_ -eq "local_config" -or $_ -like "local_config.*" }) {
      Add-Failure "$Label includes forbidden local_config path: $relativePath"
      continue
    }

    if ($item.PSIsContainer) {
      if ($forbiddenDirectories -contains $item.Name) {
        Add-Failure "$Label includes forbidden directory: $relativePath"
      }
      continue
    }

    if ($forbiddenExactFiles -contains $item.Name) {
      Add-Failure "$Label includes forbidden file: $relativePath"
      continue
    }

    foreach ($glob in $forbiddenFileGlobs) {
      if ($item.Name -like $glob) {
        Add-Failure "$Label includes forbidden artifact: $relativePath"
        break
      }
    }
  }
}

function Test-AllowedPlaceholder {
  param([string]$Value)

  $clean = $Value.Trim().Trim([char]34, [char]39)
  if ($clean -eq "") { return $true }
  if ($clean -match "^(changeme|change-me|example|placeholder|test|testnet|your[-_a-z0-9]*|<[^>]+>|\$\{[^}]+\})$") { return $true }
  if ($clean -match "^process\.env\.") { return $true }
  return $false
}

function Test-SecretMarkers {
  param(
    [string]$PackageRoot,
    [string]$Label
  )

  $textExtensions = @(".css", ".cs", ".env", ".example", ".html", ".js", ".json", ".md", ".ps1", ".txt")
  $allowedEnvSecretLikeKeys = @(
    "MEMEMAX_ORDERLY_KEY_SCOPE",
    "MEMEMAX_ORDERLY_KEY_EXPIRATION_DAYS"
  )
  $envSecretPattern = "^\s*(?<key>[A-Z0-9_]*(API_KEY|API_SECRET|ORDERLY_KEY|ORDERLY_SECRET|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|ACCOUNT_ID)[A-Z0-9_]*)\s*=\s*(?<value>.+?)\s*$"
  $literalSecretPattern = "(?i)(apiKey|apiSecret|orderlyKey|orderlySecret|accountId|token|password|privateKey|secret)\s*[:=]\s*[""'](?<value>[^""']{8,})[""']"

  foreach ($file in Get-ChildItem -LiteralPath $PackageRoot -Recurse -File -Force) {
    if ($file.Length -gt 1MB) { continue }

    $extension = $file.Extension.ToLowerInvariant()
    if (($textExtensions -notcontains $extension) -and ($file.Name -notlike ".env*")) {
      continue
    }

    $relativePath = Get-RelativePath $PackageRoot $file.FullName
    $lineNumber = 0
    foreach ($line in Get-Content -LiteralPath $file.FullName -Encoding UTF8) {
      $lineNumber += 1
      $trimmed = $line.Trim()
      if ($trimmed -eq "" -or $trimmed.StartsWith("#") -or $trimmed.StartsWith("//")) {
        continue
      }

      if ($trimmed -match $envSecretPattern) {
        $key = $Matches["key"]
        if ($allowedEnvSecretLikeKeys -contains $key) {
          continue
        }
        $value = $Matches["value"]
        if (-not (Test-AllowedPlaceholder $value)) {
          Add-Failure "$Label contains sensitive assignment marker: ${relativePath}:$lineNumber"
        }
      }

      if ($trimmed -match $literalSecretPattern) {
        $value = $Matches["value"]
        if (-not (Test-AllowedPlaceholder $value)) {
          Add-Failure "$Label contains sensitive literal marker: ${relativePath}:$lineNumber"
        }
      }
    }
  }
}

function Test-PackageFolder {
  param(
    [string]$CandidateRoot,
    [string]$Label
  )

  if (-not (Test-Path -LiteralPath $CandidateRoot -PathType Container)) {
    Add-Failure "$Label was not found: $CandidateRoot"
    return
  }

  $packageRoot = Resolve-PackageRoot $CandidateRoot
  Test-ExpectedFiles $packageRoot $Label
  Test-ForbiddenPaths $packageRoot $Label
  Test-SecretMarkers $packageRoot $Label
}

if ([System.IO.Path]::IsPathRooted($PackagePath)) {
  $resolvedPackagePath = [System.IO.Path]::GetFullPath($PackagePath)
} else {
  $resolvedPackagePath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $PackagePath))
}

if ($resolvedPackagePath.ToLowerInvariant().EndsWith(".zip")) {
  $ZipPath = $resolvedPackagePath
  $PackagePath = ""
} else {
  Test-PackageFolder $resolvedPackagePath "retail folder"
}

if (-not $SkipZip) {
  if (-not $ZipPath -and $PackagePath) {
    $ZipPath = "$resolvedPackagePath.zip"
  }

  if ($ZipPath) {
    if ([System.IO.Path]::IsPathRooted($ZipPath)) {
      $resolvedZipPath = [System.IO.Path]::GetFullPath($ZipPath)
    } else {
      $resolvedZipPath = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $ZipPath))
    }

    if (Test-Path -LiteralPath $resolvedZipPath -PathType Leaf) {
      $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("retail-package-check-" + [System.Guid]::NewGuid().ToString("N"))
      New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
      try {
        Expand-Archive -LiteralPath $resolvedZipPath -DestinationPath $tempRoot -Force
        Test-PackageFolder $tempRoot "retail zip"
      } finally {
        $fullTempRoot = [System.IO.Path]::GetFullPath($tempRoot)
        $fullSystemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        if ($fullTempRoot.StartsWith($fullSystemTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
          Remove-Item -LiteralPath $fullTempRoot -Recurse -Force
        }
      }
    } else {
      Add-Failure "retail zip was not found: $resolvedZipPath"
    }
  }
}

if ($Failures.Count -gt 0) {
  Write-Host "Retail package check failed:"
  foreach ($failure in $Failures) {
    Write-Host " - $failure"
  }
  exit 1
}

Write-Host "Retail package check passed."
