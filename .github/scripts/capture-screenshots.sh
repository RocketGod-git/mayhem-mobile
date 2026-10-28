#!/usr/bin/env bash
# Drives the app on an emulator and captures frames for the Play listing.
#
# Must run as ONE shell: android-emulator-runner executes each line of an inline `script:`
# in its own `sh -c`, so shell functions and variables do not survive between lines.
set -x

mkdir -p shots
adb install -r "$(find app/build/outputs/apk -name '*.apk' | head -1)"

# Grant location up front: the runtime prompt otherwise covers the first frames. The app
# only uses it to center the map and as the ADS-B position reference.
adb shell pm grant com.rocketgod.mayhem android.permission.ACCESS_FINE_LOCATION || true
adb shell pm grant com.rocketgod.mayhem android.permission.ACCESS_COARSE_LOCATION || true

# SystemUI demo mode: a fixed clock, full battery and signal, no stray notification icons,
# which is what store screenshots are supposed to show.
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command enter
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 1000
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false
adb shell am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 -e mobile hide
adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false

# "Physical size: 1080x2400" -> 1080 and 2400, so taps are proportional rather than
# pixel values tied to one emulator profile.
SIZE=$(adb shell wm size | tr -d '\r' | awk '{print $NF}' | tail -1)
W=${SIZE%x*}
H=${SIZE#*x}
echo "screen ${W}x${H}"

shot() {
  sleep 3
  adb exec-out screencap -p > "shots/$1.png"
  echo "captured $1 ($(stat -c%s "shots/$1.png") bytes)"
}

tap() {
  adb shell input tap "$(awk "BEGIN{print int($W*$1)}")" "$(awk "BEGIN{print int($H*$2)}")"
  sleep 2
}

back() {
  adb shell input keyevent 4
  sleep 2
}

adb shell am start -n com.rocketgod.mayhem/.MainActivity
sleep 15
shot 01-launcher

# The launcher is a 2-column grid under the header; walk the first four tiles.
tap 0.27 0.46; shot 02-tile-a; back
tap 0.73 0.46; shot 03-tile-b; back
tap 0.27 0.60; shot 04-tile-c; back
tap 0.73 0.60; shot 05-tile-d; back

# Settings sits at the end of the grid.
adb shell input swipe $((W / 2)) $((H * 3 / 4)) $((W / 2)) $((H / 4)) 300
sleep 2
shot 06-launcher-end
tap 0.73 0.72; shot 07-settings

adb shell am broadcast -a com.android.systemui.demo -e command exit
ls -la shots
