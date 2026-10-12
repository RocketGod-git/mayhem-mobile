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

ACT=com.rocketgod.mayhem/.MainActivity
open_app() { adb shell am start -n $ACT --ez demo true --es open "$1" >/dev/null; sleep "${2:-5}"; }
shot() { adb exec-out screencap -p > "$OUT/$1.png"; echo "captured $1"; }

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

adb shell am broadcast -a com.android.systemui.demo -e command exit
ls -la "$OUT"
