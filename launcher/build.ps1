$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$publish = Join-Path $PSScriptRoot 'bin\publish'
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
dotnet publish (Join-Path $PSScriptRoot 'ShiyinLauncher.csproj') -c Release "-p:Version=$version" -o $publish
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Copy-Item -LiteralPath (Join-Path $publish 'ShiyinLauncher.exe') -Destination (Join-Path $root 'ShiyinLauncher.exe') -Force
