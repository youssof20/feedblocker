$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
node tools/build.js
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
node tools/test.js
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
node tools/check.js
if ($LASTEXITCODE -ne 0) { throw 'Checks failed' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$version = (Get-Content manifest.json -Raw | ConvertFrom-Json).version
$dist = Join-Path $projectRoot 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$zipPath = Join-Path $dist "feedblocker-$version.zip"
$stream = [System.IO.File]::Open($zipPath, [System.IO.FileMode]::Create)
$zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $files = @('manifest.json', 'background.js', 'LICENSE')
  foreach ($folder in @('content', 'icons', 'popup', 'rules', 'shared')) {
    $files += Get-ChildItem -LiteralPath (Join-Path $projectRoot $folder) -File -Recurse | ForEach-Object { [System.IO.Path]::GetRelativePath($projectRoot, $_.FullName) }
  }
  foreach ($file in $files) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $projectRoot $file), $file.Replace('\','/')) | Out-Null
  }
} finally { $zip.Dispose(); $stream.Dispose() }
Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath | Format-List
Write-Output "Built $zipPath"
