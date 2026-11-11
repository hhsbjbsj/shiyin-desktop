param(
    [Parameter(Mandatory)] [string] $SourceDirectory,
    [Parameter(Mandatory)] [string] $BuildDirectory,
    [string] $CudaArchitecture = '61-virtual'
)

$ErrorActionPreference = 'Stop'
$upstreamCommit = '2eeeba56e9edd762b4b38467bab96c2517163158'
$source = (Resolve-Path -LiteralPath $SourceDirectory).ProviderPath
$engineDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'engine'
$head = git -C $source rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head -ne $upstreamCommit) {
    throw "Check out $upstreamCommit in a dedicated whisper.cpp source directory."
}

foreach ($name in 'whisper-memory.patch', 'whisper-speed.patch') {
    $patch = Join-Path $engineDirectory $name
    git -C $source apply --reverse --check $patch 2>$null
    if ($LASTEXITCODE -eq 0) { continue }
    git -C $source apply $patch
    if ($LASTEXITCODE -ne 0) { throw "Could not apply $name." }
}

cmake -S $source -B $BuildDirectory -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON `
    -DGGML_CUDA=ON -DGGML_CUDA_FORCE_MMQ=ON -DGGML_CUDA_GRAPHS=OFF "-DCMAKE_CUDA_ARCHITECTURES=$CudaArchitecture" `
    -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF -DWHISPER_BUILD_EXAMPLES=ON -DWHISPER_SDL2=OFF
if ($LASTEXITCODE -ne 0) { throw 'Whisper CMake configuration failed.' }

cmake --build $BuildDirectory --target whisper-cli --parallel 2
if ($LASTEXITCODE -ne 0) { throw 'Whisper build failed.' }
