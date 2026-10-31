# Regenerates docs/studio/*.png from the static prototype using headless Edge (1440x900).
# Usage:  powershell -ExecutionPolicy Bypass -File studio/prototype/shots.ps1 [-Only lorebook-dark]
param([string]$Only = '')
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$out = Join-Path $root 'docs\studio'
New-Item -ItemType Directory -Force $out | Out-Null
$base = 'file:///' + ($root -replace '\\', '/') + '/studio/prototype/index.html'
$tmpProfile = Join-Path $env:TEMP 'cellar-studio-shots'

$shots = @(
  @('character-dark', 'theme=dark', 'character/eirin'),
  @('character-light', 'theme=light', 'character/eirin'),
  @('lorebook-dark', 'theme=dark', 'lorebook/frost'),
  @('lorebook-light', 'theme=light', 'lorebook/frost'),
  @('lorebook-bulk-dark', 'theme=dark', 'lorebook/frost/bulk'),
  @('conflict-dark', 'theme=dark', 'conflict/eirin'),
  @('conflict-light', 'theme=light', 'conflict/eirin'),
  @('conflict-lorebook-dark', 'theme=dark', 'conflict/frost'),
  @('library-dark', 'theme=dark', 'library'),
  @('library-offline-dark', 'theme=dark&tv=tt', 'library'),
  @('library-preview-dark', 'theme=dark', 'library/preview'),
  @('sync-dark', 'theme=dark', 'sync'),
  @('sync-offline-wait-dark', 'theme=dark&ttoff=wait', 'sync'),
  @('sync-unbound-dark', 'theme=dark&unbound=1', 'sync'),
  @('settings-dark', 'theme=dark', 'settings'),
  @('settings-taverns-dark', 'theme=dark&sec=conn', 'settings'),
  @('settings-closed-dark', 'theme=dark&sec=conn&ttaccept=0', 'settings'),
  @('history-dark', 'theme=dark', 'history'),
  @('wizard-dark', 'theme=dark&step=0', 'wizard'),
  @('wizard-connect-dark', 'theme=dark&step=2', 'wizard')
)
foreach ($s in $shots) {
  if ($Only -and $s[0] -ne $Only) { continue }
  $file = Join-Path $out ($s[0] + '.png')
  $url = $base + '?' + $s[1] + '#' + $s[2]
  cmd /c "`"$edge`" --headless=new --disable-gpu --hide-scrollbars --no-first-run --user-data-dir=`"$tmpProfile`" --window-size=1464,990 --virtual-time-budget=1500 --screenshot=`"$file.raw.png`" `"$url`" >nul 2>nul"
  # new headless reserves space for window decorations (viewport = window - 24x90): crop to the real 1440x900 viewport
  $img = [System.Drawing.Image]::FromFile("$file.raw.png")
  $bmp = New-Object System.Drawing.Bitmap 1440, 900
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, 1440, 900), (New-Object System.Drawing.Rectangle 0, 0, 1440, 900), [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose(); $img.Dispose(); $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Remove-Item "$file.raw.png"
  Write-Output ("{0,-24} {1}" -f $s[0], (Test-Path $file))
}
