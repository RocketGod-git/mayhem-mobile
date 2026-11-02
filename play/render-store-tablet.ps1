# Renders the Play Store 10-inch tablet screenshots (en-US/tablet/*.png) from store-shot-tablet.html and the
# landscape Pixel C captures in captures/tablet/. Run from anywhere: powershell -File play/render-store-tablet.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
$out = Join-Path $here 'en-US\tablet'
New-Item -ItemType Directory -Force $out | Out-Null
$profileDir = Join-Path $env:TEMP 'mayhem-store-render'
Add-Type -AssemblyName System.Drawing

# file name, capture, headline, line under it. Order is the order on the Store.
$shots = @(
    @('1-launcher', 'launcher.png', 'Your tablet is the radio.', 'Plug in a HackRF, PortaPack or RTL-SDR. Everything runs on the device.'),
    @('2-adsb', 'adsb.png', 'Every plane overhead, live on a map.', 'ADS-B from 1090 MHz with callsigns, altitude and track. Your own antenna, no feed.'),
    @('3-audio', 'audio.png', 'FM, AM and SSB, waterfall wide.', 'Slide to tune, RDS names and radio text, NOAA weather alerts, bookmarks and a scanner.'),
    @('4-lookingglass', 'lookingglass.png', 'Sweep a whole band. See what is on.', 'Looking Glass stitches slice after slice into one waterfall, 1 MHz to 6 GHz on a HackRF.')
)
foreach ($s in $shots) {
    $q = 'img=' + [uri]::EscapeDataString("captures/tablet/$($s[1])") + '&h=' + [uri]::EscapeDataString($s[2]) + '&s=' + [uri]::EscapeDataString($s[3])
    $url = 'file:///' + ((Join-Path $here 'store-shot-tablet.html') -replace '\\', '/') + '?' + $q
    $png = Join-Path $out "$($s[0]).png"
    & $edge --headless=new --hide-scrollbars --window-size=2560,1600 --virtual-time-budget=8000 --user-data-dir="$profileDir" --screenshot="$png" $url | Out-Null
    Start-Sleep -Milliseconds 500
    # flattened to 24-bit RGB, as Play wants
    $src = [System.Drawing.Image]::FromFile($png)
    $rgb = New-Object System.Drawing.Bitmap 2560, 1600, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($rgb); $g.DrawImage($src, 0, 0, 2560, 1600); $g.Dispose(); $src.Dispose()
    $rgb.Save($png, [System.Drawing.Imaging.ImageFormat]::Png); $rgb.Dispose()
    Write-Output "$png"
}
