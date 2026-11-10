param([string]$OutputDirectory = 'dist', [string]$Tag)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$' -or ($Tag -and $Tag -ne "v$version")) { throw 'The package version must match the release tag.' }
$output = [IO.Path]::GetFullPath($OutputDirectory, $root)
$stage = Join-Path $output ('stage-' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $stage 'payload'
New-Item -ItemType Directory -Path $payload -Force | Out-Null

try {
    $files = 'server.js', 'platforms.js', 'package.json', 'package-lock.json', 'public', 'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'setup-tools.ps1'
    foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $root $file) -Destination $payload -Recurse }

    Push-Location $payload
    try {
        npm ci --omit=dev --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    } finally { Pop-Location }

    $nodeVersion = '24.15.0'
    $nodeName = "node-v$nodeVersion-win-x64"
    $nodeUrl = "https://nodejs.org/dist/v$nodeVersion"
    $nodeZip = Join-Path $stage "$nodeName.zip"
    $hashes = Join-Path $stage 'SHASUMS256.txt'
    & curl.exe --fail --location --silent --show-error --retry 2 --output $nodeZip "$nodeUrl/$nodeName.zip"
    if ($LASTEXITCODE -ne 0) { throw 'Node.js download failed.' }
    & curl.exe --fail --location --silent --show-error --retry 2 --output $hashes "$nodeUrl/SHASUMS256.txt"
    if ($LASTEXITCODE -ne 0) { throw 'Node.js checksum download failed.' }
    $nodeHash = (Get-Content -LiteralPath $hashes | Where-Object { $_ -match ('^[a-f0-9]{64}\s+' + [regex]::Escape("$nodeName.zip") + '$') }) -split '\s+' | Select-Object -First 1
    if (!$nodeHash -or (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash -ne $nodeHash) { throw 'Node.js archive checksum mismatch.' }
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $stage
    Copy-Item -LiteralPath (Join-Path $stage "$nodeName/node.exe") -Destination $payload
    Copy-Item -LiteralPath (Join-Path $stage "$nodeName/LICENSE") -Destination (Join-Path $payload 'Node-LICENSE.txt')

    $publish = Join-Path $stage 'launcher'
    dotnet publish (Join-Path $root 'launcher/ShiyinLauncher.csproj') -c Release -r win-x64 --self-contained true -p:IncludeNativeLibrariesForSelfExtract=true "-p:Version=$version" -o $publish
    if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed.' }
    Copy-Item -LiteralPath (Join-Path $publish 'ShiyinLauncher.exe') -Destination $payload
    $dotnet = Split-Path -Parent (Get-Command dotnet -CommandType Application | Select-Object -First 1 -ExpandProperty Source)
    Get-Content -LiteralPath (Join-Path $dotnet 'LICENSE.txt'), (Join-Path $dotnet 'ThirdPartyNotices.txt') |
        Set-Content -LiteralPath (Join-Path $payload 'Dotnet-LICENSE.txt') -Encoding utf8

    & (Join-Path $payload 'node.exe') --check (Join-Path $payload 'server.js')
    if ($LASTEXITCODE -ne 0) { throw 'Packaged server syntax check failed.' }
    node (Join-Path $root 'scripts/check-html.js') (Join-Path $payload 'public/index.html')
    if ($LASTEXITCODE -ne 0) { throw 'Packaged webpage syntax check failed.' }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stagedZip = Join-Path $stage 'Shiyin-win-x64.zip'
    [IO.Compression.ZipFile]::CreateFromDirectory($payload, $stagedZip, [IO.Compression.CompressionLevel]::Optimal, $false)
    $archive = Join-Path $output 'Shiyin-win-x64.zip'
    Move-Item -LiteralPath $stagedZip -Destination $archive -Force
    Get-FileHash -LiteralPath $archive -Algorithm SHA256
} finally {
    if ((Split-Path -Parent $stage) -eq $output -and (Split-Path -Leaf $stage) -match '^stage-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
