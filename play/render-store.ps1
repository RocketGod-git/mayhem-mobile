# Renders the Play Store phone screenshots (en-US/phone/*.png) from store-shot.html and the real captures in
# captures/. Run from anywhere: powershell -File play/render-store.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
$out = Join-Path $here 'en-US\phone'
New-Item -ItemType Directory -Force $out | Out-Null
$profileDir = Join-Path $env:TEMP 'mayhem-store-render'

# file name, capture, headline, line under it. Order is the order on the Store.
$shots = @(
    @('1-launcher', 'launcher.png', 'Your phone is the radio.', 'Plug in a HackRF, PortaPack or RTL-SDR. Everything runs on the phone.'),
    @('2-adsb', 'adsb.png', 'Every plane overhead, live on a map.', 'ADS-B from 1090 MHz with callsigns, altitude and track. No internet feed: your own antenna.'),
    @('3-audio', 'audio.png', 'FM, AM and SSB with station info.', 'Slide to tune, RDS names and radio text, NOAA weather alerts, bookmarks and a scanner.'),
    @('4-lookingglass', 'lookingglass.png', 'Sweep a whole band. See what is on.', 'Looking Glass stitches slice after slice into one waterfall, from 1 MHz to 6 GHz on a HackRF.')
)
foreach ($s in $shots) {
    $q = 'img=' + [uri]::EscapeDataString("captures/$($s[1])") + '&h=' + [uri]::EscapeDataString($s[2]) + '&s=' + [uri]::EscapeDataString($s[3])
    $url = 'file:///' + ((Join-Path $here 'store-shot.html') -replace '\\', '/') + '?' + $q
    $png = Join-Path $out "$($s[0]).png"
    & $edge --headless=new --hide-scrollbars --window-size=1080,1920 --virtual-time-budget=8000 --user-data-dir="$profileDir" --screenshot="$png" $url | Out-Null
    Start-Sleep -Milliseconds 500
    Write-Output "$png"
}

# The feature graphic, flattened to RGB: Play refuses one with an alpha channel.
$fg = Join-Path $here 'en-US\feature-graphic.png'
$url = 'file:///' + ((Join-Path $here 'feature-graphic.html') -replace '\\', '/')
& $edge --headless=new --hide-scrollbars --window-size=1024,500 --virtual-time-budget=8000 --user-data-dir="$profileDir" --screenshot="$fg" $url | Out-Null
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile($fg)
$rgb = New-Object System.Drawing.Bitmap 1024, 500, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($rgb); $g.DrawImage($src, 0, 0, 1024, 500); $g.Dispose(); $src.Dispose()
$rgb.Save($fg, [System.Drawing.Imaging.ImageFormat]::Png); $rgb.Dispose()
Write-Output $fg
