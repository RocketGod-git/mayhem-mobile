#!/usr/bin/env bash
# Opens every screen of a debug build on an emulator, fed by the synthetic demo signal, and captures each one in
# portrait and landscape, plus the picture-in-picture window. For checking layouts on a phone and a tablet.
# Must run as ONE shell (android-emulator-runner runs each inline line in its own sh -c).
set -x
OUT=${1:-shots}
mkdir -p "$OUT"
adb install -r "$(find app/build/outputs/apk/debug -name '*.apk' | head -1)"
adb shell pm grant com.rocketgod.mayhem android.permission.ACCESS_FINE_LOCATION || true
adb shell pm grant com.rocketgod.mayhem android.permission.ACCESS_COARSE_LOCATION || true
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command enter
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 1000
adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false
adb shell settings put system accelerometer_rotation 0
# the demo's ADS-B is a real recording from southern California: put the emulator there, as a phone would be
adb emu geo fix -118.9 34.5 || true

ACT=com.rocketgod.mayhem/.MainActivity
open_app() { adb shell am start -n $ACT --ez demo true --es open "$1" >/dev/null; sleep "${2:-5}"; }
shot() { adb exec-out screencap -p > "$OUT/$1.png"; echo "captured $1"; }

adb logcat -c || true
adb shell am start -n $ACT --ez demo true
sleep 12

APPS="HOME HAM AUDIO DEVICES SAT ADSB AIS APRS PAGER ERT BTLE TPMS ACARS SUBGHZ PROWL LOOKING_GLASS SEARCH CAPTURE TRANSMIT SETTINGS"
for rot in 0 1; do
  adb shell settings put system user_rotation $rot
  sleep 3
  tag=$([ $rot = 0 ] && echo portrait || echo landscape)
  n=0
  for a in $APPS; do
    n=$((n + 1))
    open_app "$a" 5
    shot "$(printf '%s-%02d-%s' "$tag" "$n" "$a")"
  done
done
adb shell settings put system user_rotation 0
sleep 2

# picture-in-picture: open the receiver, go home, photograph the floating window
open_app AUDIO 5
adb shell input keyevent KEYCODE_HOME
sleep 5
shot pip-audio
open_app PROWL 4
adb shell input keyevent KEYCODE_HOME
sleep 5
shot pip-prowl

# the same demo dressed as an RTL-SDR: dimmed tiles, one gain control, receive-only panels
for a in HOME AUDIO HAM LOOKING_GLASS PROWL TRANSMIT SAT; do
  adb shell am start -n $ACT --ez demo true --es radio RTLSDR --es open "$a" >/dev/null; sleep 5
  shot "rtl-$a"
done

# store frames, in the device's natural orientation: the same screens left long enough for the waterfall to fill,
# the recorded traffic to build up on the map and a Looking Glass sweep to finish
adb shell settings put system user_rotation 0
sleep 3
# (the emulator makes the demo slower than real time, so a waterfall takes minutes to fill). As a HackRF, which the
# RTL-SDR pass before this leaves behind.
for a in HOME:180 AUDIO:180 ADSB:60 LOOKING_GLASS:180; do
  adb shell am start -n $ACT --ez demo true --es radio HACKRF --es open "${a%%:*}" >/dev/null; sleep "${a##*:}"
  shot "store-${a%%:*}"
done

adb shell am broadcast -a com.android.systemui.demo -e command exit
adb logcat -d > "$OUT/logcat.txt" || true
ls -la "$OUT"
