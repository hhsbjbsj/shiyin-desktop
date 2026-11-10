$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$bin = Join-Path $PSScriptRoot 'bin'
$stage = Join-Path $bin ('.tools-' + [Guid]::NewGuid().ToString('N'))

function Get-VerifiedFile([string]$Url, [string]$Name, [string]$Sha256) {
    $file = Join-Path $stage $Name
    & curl.exe --fail --location --silent --show-error --retry 2 --connect-timeout 20 --max-time 420 --output $file $Url
    if ($LASTEXITCODE -ne 0) { throw "下载 $Name 失败，请检查 GitHub 网络连接。" }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $Sha256) { throw "$Name 校验失败。" }
    return $file
}

New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
    $engine = Join-Path $bin 'Release'
    if (!(Test-Path -LiteralPath (Join-Path $engine 'whisper-cli.exe'))) {
        $file = Get-VerifiedFile `
            'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip' `
            'whisper.zip' 'b07ea0b1b4115a38e1a7b07debf581f0b77d999925f8acb8f39d322b0ba0a822'
        $expanded = Join-Path $stage 'whisper'
        Expand-Archive -LiteralPath $file -DestinationPath $expanded
        $cli = Get-ChildItem -LiteralPath $expanded -Filter 'whisper-cli.exe' -Recurse -File | Select-Object -First 1
        if (!$cli) { throw 'Whisper 下载包缺少识别程序。' }
        New-Item -ItemType Directory -Path $engine -Force | Out-Null
        Get-ChildItem -LiteralPath $cli.DirectoryName -Filter '*.dll' -File | Copy-Item -Destination $engine -Force
        Copy-Item -LiteralPath $cli.FullName -Destination $engine
    }

    $ffmpeg = Join-Path $bin 'ffmpeg'
    $env:Path = "$ffmpeg;$env:Path"
    if (!(Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) -or !(Get-Command ffprobe.exe -ErrorAction SilentlyContinue)) {
        $file = Get-VerifiedFile `
            'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/autobuild-2026-11-10-12-39/ffmpeg-n8.1.3-34-ga35157abb9-win64-lgpl-shared-8.1.zip' `
            'ffmpeg.zip' '3045c2213ed8cbb05edf0d5a631b4490061de3b7567ec145644156e7c98da2c6'
        $expanded = Join-Path $stage 'ffmpeg'
        Expand-Archive -LiteralPath $file -DestinationPath $expanded
        $encoder = Get-ChildItem -LiteralPath $expanded -Filter 'ffmpeg.exe' -Recurse -File | Select-Object -First 1
        if (!$encoder -or !(Test-Path -LiteralPath (Join-Path $encoder.DirectoryName 'ffprobe.exe'))) { throw 'FFmpeg 下载包不完整。' }
        New-Item -ItemType Directory -Path $ffmpeg -Force | Out-Null
        Get-ChildItem -LiteralPath $encoder.DirectoryName -File | Copy-Item -Destination $ffmpeg -Force
    }

    $downloader = Join-Path $bin 'yt-dlp.exe'
    if (!(Test-Path -LiteralPath $downloader) -and !(Test-Path -LiteralPath (Join-Path $bin 'yt-dlp-pkg\yt_dlp\__init__.py'))) {
        $file = Get-VerifiedFile `
            'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe' `
            'yt-dlp.exe' 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d'
        Move-Item -LiteralPath $file -Destination $downloader
    }
} finally {
    if ((Split-Path -Parent $stage) -eq $bin -and (Split-Path -Leaf $stage) -match '^\.tools-[a-f0-9]{32}$') {
        Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
