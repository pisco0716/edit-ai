$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$pythonExe = Join-Path $env:LOCALAPPDATA "Programs\Python\Python312\python.exe"
$pythonArgs = @()
$pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
if ($pythonCommand -and $pythonCommand.Source -notlike "*WindowsApps*") {
    $pythonExe = $pythonCommand.Source
} elseif (-not (Test-Path $pythonExe)) {
    $pythonLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($pythonLauncher) {
        $pythonExe = $pythonLauncher.Source
        $pythonArgs = @("-3.12")
    } else {
        throw "Python 3.10+ is not installed. Install Python, reopen PowerShell, and run this script again."
    }
}

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    & $pythonExe @pythonArgs -m venv .venv
}
& $venvPython -m pip install -r requirements.txt

$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([^#=]+)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), 'Process')
        }
    }
}

if (-not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)) {
    $wingetPackages = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
    $ffmpegPackage = Get-ChildItem $wingetPackages -Directory -Filter "Gyan.FFmpeg.Shared*" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($ffmpegPackage) {
        $ffmpegBinary = Get-ChildItem $ffmpegPackage.FullName -Directory -Filter "ffmpeg-*-full_build-shared" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($ffmpegBinary -and (Test-Path (Join-Path $ffmpegBinary.FullName "bin\ffmpeg.exe"))) {
            $env:PATH = "$(Join-Path $ffmpegBinary.FullName 'bin');$env:PATH"
        }
    }
}

if (-not $env:OPENAI_API_KEY) {
    Write-Warning "OPENAI_API_KEY is not configured. Create backend/.env from .env.example and enter your OpenAI API key. The API will start, but AI editing will return a setup error until then."
}
if (-not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue)) {
    Write-Warning "ffmpeg.exe is not on PATH. Install FFmpeg and restart this terminal before rendering videos."
}

& $venvPython -m uvicorn main:app --host 127.0.0.1 --port 8000
