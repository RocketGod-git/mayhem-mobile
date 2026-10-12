# mayhem-mobile — Mayhem on Android

A native Android app (Kotlin + Jetpack Compose) that drives a **HackRF directly over USB-OTG** and does the
SDR work on the phone: raw 8-bit IQ in, FFT waterfall, WFM / NFM / AM demod to the speaker, Mode-S/ADS-B decode,
and — over time — ports of the other [PortaPack Mayhem](https://github.com/portapack-mayhem/mayhem-firmware)
receivers. The phone is the UI: no PortaPack screen needed.

Two paths exist for the same physical device — this project is the first one:

| Path | USB id | Who does the DSP | Driver |
|---|---|---|---|
| **HackRF-direct (this project)** | `1d50:6089` (One / One r9 / **Pro**), `604b` Jawbreaker, `cc15` rad1o | the phone, in Kotlin | `usb/HackRfOne.kt` |
| PortaPack / Mayhem serial (not this project) | `1d50:6018` | Mayhem firmware on the device | — |

A PortaPack running Mayhem must be put in its on-screen **HackRF** mode to be used by this app.

## The drivers

There is no native code in this project — no NDK, no JNI, no libusb, no prebuilt `.so`. The HackRF is
driven from Kotlin on Android's `UsbDeviceConnection`, and from TypeScript over WebUSB in the browser
build. Both speak the libhackrf vendor protocol directly:

- Vendor control transfers, `bmRequestType` IN `0xC0` / OUT `0x40`, recipient device; the request byte
  selects the operation.
- `SET_FREQ` (16) carries `{uint32 MHz, uint32 Hz}` and `SAMPLE_RATE_SET` (6) carries
  `{uint32 rate, uint32 divider}` — eight bytes, little-endian, in the data stage.
- `BASEBAND_FILTER_BANDWIDTH_SET` (7) has no data stage at all: the 32-bit bandwidth is split across
  `wValue` (low 16) and `wIndex` (high 16).
- `SET_LNA_GAIN` (19) and `SET_VGA_GAIN` (20) are IN transfers that carry the value in `wIndex` and
  return a one-byte ack. `AMP_ENABLE` (17) and `SET_TRANSCEIVER_MODE` (1) are OUT, value in `wValue`,
  no data.
- `SET_HW_SYNC_MODE` (29) is switched off at bring-up: left enabled by some other host, the firmware
  waits for an external trigger and streams nothing but zeros.
- IQ arrives on an async bulk endpoint through a pool of `UsbRequest`s over direct `ByteBuffer`s. The
  HackRF sends **signed** 8-bit IQ while the DSP wants offset-128, so every byte is XORed with `0x80`.
- Frequency, sample rate and gain live in `@Volatile` fields. The RX loop compares them with what it
  last applied and re-programs between buffers, so retuning never tears the stream down.

The board is identified by `BOARD_ID_READ` (14), not by PID: 1 Jawbreaker, 2 HackRF One, 3 rad1o,
4 HackRF One r9, 5 HackRF Pro — the Pro shares the One's `0x6089`. USB ids are VID `0x1d50` with PIDs
`0x6089`, `0x604b` and `0xcc15`; a PortaPack left in Mayhem serial mode (`0x6018`) is recognised and
reported as needing its on-screen HackRF mode.

`usb/HackRfOne.kt` is the driver and `usb/HackRfUsb.kt` handles enumeration and permissions. The
browser twin is `web/src/hackrf.ts`, which also has an RTL-SDR driver beside it in `web/src/rtlsdr.ts`.

## Status

The app is a Mayhem-style launcher of HackRF-DSP apps. Everything below runs from raw IQ on the phone; nothing
needs a PortaPack. Games and PortaPack-hardware apps (battery, touch calibration, SD card, external modules,
flashing) are deliberately out of scope. TX apps are not ported yet (see below).

| Mayhem app | This app | Notes |
|---|---|---|
| Audio (WFM / NFM / AM / SSB) | **Audio** | waterfall with slide-to-tune, log-scale band slider, squelch, bookmarks + scan, amp/LNA/VGA |
| ADS-B RX (adsbrx) | **ADS-B** | dump1090-style Mode-S decode, live aircraft map (OpenStreetMap, follows the traffic) + list, phone GPS as the CPR reference |
| AIS RX | **AIS** | GMSK 9600 via NFM discriminator, HDLC, types 1/2/3/4/5/18/21/24, vessel table |
| APRS RX | **APRS** | Bell 202 AFSK, AX.25, uncompressed positions |
| FLEX RX + POCSAG RX | **FLEX** | FLEX 1600/3200 bps 2-/4-level by default (proc_flex port: FIW, BIW, alpha / numeric / tone / hex / instruction pages); a decoder chip switches to POCSAG 512/1200/2400 auto-baud with BCH(31,21), or runs both on one channel like PDW |
| ERT | **ERT** | Itron SCM / SCM+ / IDM, OOK Manchester 32.768 kbaud |
| BLE RX (btle_rx) | **BLE RX** | channels 37/38/39, de-whitening + CRC-24, AD structures |
| TPMS RX | **TPMS** | Schrader-family tyre sensors on 315 / 433.92 MHz: FSK 19.2k (FLM 64/72/80), OOK 8.192k, OOK 8.4k (GMC); Manchester, CRC-8 / checksums, kPa + psi, °C + °F |
| ACARS RX | **ACARS** | AM + 2400 bps MSK, per-bit differential decision (acarsdec style), SYN/SOH framing, odd parity, CRC-16, registration / label / block / message number / flight / text |
| Weather Station, SubGhzD, SubCar (fprotos/) | **Sub-GHz** | rtl_433-style: 26 weather sensors, 47 remotes and gate openers (Princeton, CAME, Nice, KeeLoq, Somfy, Security+ …), 11 car key fobs, all running at once on one OOK pulse detector, with the field decoders from Mayhem's apps |
| Looking Glass | **Looking Glass** | stepped sweep across any range, stitched waterfall, slide + release to listen |
| Search | **Search** | same sweep; lists bins above the noise floor, tap to listen |
| Capture | **Capture** | raw IQ to `.c8` + Mayhem-style `.txt` sidecar |
| Level / Detector / Tone search | (Audio readout) | the RX-health line shows peak-vs-floor dB |
| Frequency manager / Scanner | **Bookmarks + SCAN** (Audio) | saved frequencies with mode; scan hops through them and holds while the squelch is open |
| (none — Mayhem has no ham-radio receiver) | **HAM Radio** | RECEIVE: USB / LSB / CW / AM / NFM channel receiver anywhere in the span (phasing SSB, AGC, noise reduction, auto-notch, CTCSS / DCS, S-meter, band plan with repeater offsets). MONITOR: every channel in the span at once. DIGITAL: CW, RTTY, PSK31, FT8 (full ft8_lib LDPC decode), SSTV (Martin / Scottie / Robot / PD incl. the ISS's PD120) and DMR (both time slots, talkgroups / IDs / talker alias, AMBE+2 voice via a port of mbelib) with an AUTO mode that picks the decoder that is making sense; P25 / D-STAR / NXDN / YSF are identified by sync word. SATELLITE: SGP4 tracking from the phone's GPS, passes, Doppler-tracked listening, APRS from the ISS, SSTV, NOAA APT and Meteor-M LRPT pictures (72 kbaud QPSK, Viterbi, Reed-Solomon, the MSU-MR JPEG strips, live colour composite), and push-to-talk on the uplink with Doppler and the bird's tone. TRANSMIT: FM voice from the microphone with CTCSS on the repeater input. LOGBOOK: contacts with callsign details (prefix → entity offline; HamQTH / hamdb / callook online for name, QTH, grid, zones), worked-before, distance and bearing from your grid, ADIF export / import, CSV; FT8 decodes and satellite packets log with a tap. |
| Sonde, Weather, SubGHz, AFSK, NRF, EPIRB, VOR, WEFAX, FM RDS, Recon | planned | pure-DSP ports, same IqProcessor pattern |
| Signal Gen, Tones/DTMF, POCSAG TX, RTTY TX, APRS TX, Morse, OOK TX, Replay | **Transmit** | on by default, with a one-off "do you have an antenna or a dummy load?" prompt on the first send each session (can be switched back off in Settings): CW / FM / AM / sweep generator; 1 kHz / two-tone / DTMF; POCSAG pager (512/1200/2400, alpha + numeric, round-trip-verified against the Pager RX decoder); RTTY (ITA2 Baudot 45 bd); APRS (Bell 202 AX.25, round-trip-verified against the APRS decoder); a Morse keyer (CW or FM tone); fixed-code Princeton/PT2262 OOK; and `.c8` replay (Android). All on a 100 kHz digital offset off the LO. TX VGA 0–47 dB + amp. |
| MDC-1200 TX, Quick-Call II two-tone, SubGHz .sub replay, KeeLoq HCS301, OOK noise, OOK brute, frequency hopper, ADS-B TX | **Transmit** | ports of upstream Mayhem's `ui_mdc_tx`, `ui_test` (QC-II), `ui_flippertx`, `ui_keyfob`, `ui_jammer`, `ookbrute`, `ui_lge` and `ui_adsb_tx`. MDC-1200 is 1200 bps AFSK ±2.5 kHz FM with CRC-16-CCITT + K=7 conv + 16-way interleaver, faithful to `ui_mdc_tx`. KeeLoq encrypts a 32-bit hop code with the standard 528-round cipher (NLF 0x3A5C742E) and emits the HCS301 wake-up + 66-bit PWM payload. ADS-B is a 112-bit DF17 Extended Squitter with CRC-24 (poly 0xFFF409), PPM at 8 Msps. Same "have you got an antenna?" prompt gates them all — for authorised use on your own equipment or a dummy load. |

**Waterfall (web):** rendered at device resolution — one column per device pixel (up to 4096), the FFT sized to
match (2048–16384 points), every sample between 30 Hz frames power-averaged into the row, a median noise floor with
a 40 dB display range, inferno colour map, a glowing spectrum trace with a dB grid, the demodulated channel shaded,
the strongest carriers labelled with frequency and level, and a seconds ruler down the left edge. On desktop the
launcher and every receiver put the waterfall in a full-height left pane with the apps / controls in a side column;
ultra-wide screens are not capped.

**Gain (web):** an AGC (on by default, `G` or the AGC chip toggles it; a manual LNA / VGA tap switches it off)
holds the ADC level between 7 and 22 counts RMS, where the 8-bit converter has both resolution and headroom. The
per-app presets are written for a HackRF One; a Pro needs roughly 28 dB more VGA for the same level (One presets
leave it under one count), so the app rescales them after bring-up (LNA 40, VGA + 28) and the AGC trims from there.

The spectrum's signal labels come from a smoothed peak-hold trace, so a wide FM station gets one label on its centre
rather than on this frame's tallest modulation spike; anything 6 dB over the median floor is labelled. The APK card
is shown only to Android browsers, in Settings.

**HAM Radio (web):** the digital decoders run on the receiver's own audio or discriminator, so anything the
channel receiver can hear can be decoded: FT8 is a TypeScript port of ft8_lib (Costas sync, LDPC belief
propagation, full message unpacking, plus an encoder for the Transmit app); DMR is a complete ETSI TS 102 361
receiver (4FSK timing from the sync words with automatic polarity, Golay / BPTC / RS / CRC / QR checked
headers, CSBKs and embedded link control, colour-code voting, both slots followed, AMBE+2 voice through a port of
mbelib's 3600×2450 vocoder — the same ISC-licensed code DSD uses); SSTV times each line from its sync pulse and
paints rows as they arrive; APT envelope-detects the 2400 Hz subcarrier and finds the 1040 Hz sync burst. The
SATELLITE tab carries a curated catalogue with each bird's services (FM repeater, linear transponder, APRS
digipeater, SSTV, APT, LRPT) and sets the receiver up per service; LISTEN follows the Doppler, PTT transmits on
the Doppler-corrected uplink with the satellite's CTCSS. Meteor LRPT runs a QPSK demodulator on the 240 kHz
baseband (fourth-power acquisition, Costas loop, Gardner timing), finds frames under every constellation
ambiguity, Viterbi-decodes and descrambles them, corrects the four interleaved Reed-Solomon code words and turns
the M-PDU image packets into 1568-pixel lines as they arrive; the packet and MCU layout follows meteor_decode
(MIT). The waterfall zooms (corner control, ctrl+wheel, pinch), pans (shift-drag, two fingers), follows the tuned
channel when zoomed, and the channel's edges drag to set the filter. Zooming out past 1x widens the span itself
by raising the HackRF sample rate (1.92 -> 3.84 -> 7.68 -> 15.36 -> 19.2 Msps on a desktop, 3.84 on a phone), a
span bar under the axis slides the view along the band like a scrollbar (48 MHz of reach at 1.92 Msps) while the dial
stays put, and a wheel notch over the waterfall moves one filter width on the band's channel raster. Tapping a labelled signal on the waterfall snaps the dial to its
measured centre (pulled onto the channel raster when it is close) and picks the mode and filter width from its shape.

**Frequency readout (web):** ten digits from 1 GHz to 1 Hz, each its own control — wheel over a digit, click or
tap its top half for +1 and its bottom half for −1, or focus one and use ↑ ↓ / type a number (the cursor moves to
the next digit). Leading zeros are dimmed and each group is captioned GHz / MHz / kHz / Hz, so a jump to 1.09 GHz
is one click on the GHz digit.

**Tuning gesture (both platforms):** press the waterfall and slide left or right. An amber guide line and the
readout follow your finger; the radio retunes once, when you lift it (or release the mouse button). A plain tap
does the same. Mouse wheel and ← → still step on desktop.

Still to verify in the field: this build compiles in CI but the packet decoders have not yet been exercised
against a live HackRF (the FLEX and POCSAG decoders are exercised against synthetic frames). The on-screen LOG panel and the once/sec `iqRMS` line are the first thing to check.

## Web app (WebUSB) — same build as the APK

`web/` is Mayhem Mobile for the browser, feature-matched to the APK: the HackRF driver ported to WebUSB
(`web/src/hackrf.ts`, including the Pro cache-bust retune), the DSP engine in a Web Worker
(`web/src/dsp.worker.ts`: FFT waterfall, WFM / NFM / AM / USB / LSB to an AudioWorklet, the NFM tap for packet
modes), every decoder ported to TypeScript (`web/src/dsp/`: ADS-B with CPR + phone GPS reference, AIS, APRS,
POCSAG with BCH, FLEX, ERT, BLE, sweeps), IQ capture into the browser's private file system with download, the same
launcher and screens, and the same theme skins. It runs in Chrome / Edge on Android, Windows, macOS and Linux;
Safari (iPhone / iPad) and Firefox have no WebUSB. It is an installable PWA.

**Versioning is shared.** `release.yml` builds the APK and deploys the site from the same commit; the site reads
`version.json` (version, commit, APK URL) and shows a *Download APK* button that always points at that same
build. The APK's Settings → About shows the same version and commit. Bump `versionName` / `versionCode` in
`app/build.gradle.kts` and everything follows.

Live at https://rocketgod-git.github.io/mayhem-mobile/ — the release workflow pushes the built site to the
`gh-pages` branch (Settings → Pages → Source: Deploy from a branch → `gh-pages` / root). To serve it at
**mayhem.app**: add a CNAME record for `mayhem.app` → `rocketgod-git.github.io`, set the custom domain in
Settings → Pages, and add `cname: mayhem.app` to the gh-pages step in `release.yml`. The `.app` TLD is
HTTPS-only, which WebUSB requires anyway.

Local dev: `cd web && npm ci && npm run build`, then serve the `web/` folder over `http://localhost` (WebUSB
allows localhost without TLS).

The web decoders are hand-ported twins of the Kotlin ones (same algorithms, same constants); a Kotlin
Multiplatform core compiled to WebAssembly remains the route to one DSP codebase. What only the APK can do:
auto-launch on plug-in, keep running in the background, and write captures straight to phone storage.

## Look and feel

Flat, dark, monospace: solid fills, one-pixel edges, an accent stripe across the status bar — the PortaPack
screen's language, scaled to a phone. **Settings → Theme** offers Mayhem's own firmware skins (Default,
Yellow, Aqua, Green, Red, Dark, lifted from `firmware/application/theme.cpp`) next to the *Mayhem Mobile*
default and Wardrive Go's *Cyan* palette; the choice persists. Layouts adapt to the window: phones stack
the waterfall above the controls, anything from 720 dp wide (or landscape) goes two-pane with the waterfall
left and controls right, and type/spacing scale up on tablets.

## Layout

```
app/src/main/java/com/rocketgod/mayhem/
  MainActivity.kt        USB attach / permission / detach → runs the driver on its own thread
  Diag.kt                in-memory + logcat diagnostic log (shown on screen via the LOG toggle)
  usb/HackRfUsb.kt       enumeration + permission helpers, VID/PID table
  usb/HackRfOne.kt       pure-Kotlin libhackrf-protocol driver (control transfers + async bulk IQ)
  core/SdrEngine.kt      DSP hub: FFT/waterfall, WFM/NFM/AM demod, gain model, mode/tuning state
  core/Apps.kt           the app menu + per-app engine configuration (Mayhem's receiver_model per app)
  core/IqProcessor.kt    baseband-processor interface, BitSync, HDLC framer, PacketLog
  core/AdsbDecoder.kt    Mode-S / ADS-B decoder from raw IQ (preamble, Manchester, CRC-24, CPR)
  core/apps/*.kt         POCSAG, AIS, APRS, ERT, BLE decoders, sweep processor, IQ recorder
  ui/Theme.kt            skins (Mayhem firmware themes), live palette, responsive dimensions
  model/Aircraft.kt
  ui/*.kt                launcher grid, audio / packet / sweep / capture screens, waterfall, controls
app/src/main/res/xml/usb_device_filter.xml   HackRF PIDs for the USB_DEVICE_ATTACHED hot-plug filter
```

## Building

Requires JDK 17. The Gradle wrapper pins Gradle 8.7; the toolchain (AGP 8.6.1, Kotlin 2.0.21, Compose BOM
2024.12.01, compileSdk 36, minSdk 26) mirrors Wardrive Go, whose CI proves it on GitHub runners.

```
./gradlew assembleDebug      # → app/build/outputs/apk/debug/app-debug.apk
```

CI: `android-build.yml` is the compile check for branches and PRs (debug APK as a workflow artifact).
`release.yml` runs on every push to `main`: it builds the APK + AAB, publishes the rolling `latest` GitHub
release (release-signed when the `ANDROID_KEYSTORE_B64` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_PASSWORD`
secrets exist, debug-signed otherwise), then deploys the web app to GitHub Pages from the same commit. A `v*`
tag makes a full release instead of `latest`. Play upload is intentionally not wired yet.

## Field notes

- **Power:** a HackRF (especially the Pro) can exceed what a phone's OTG port supplies. Use a powered OTG hub
  if the log shows an all-zero RX or the device drops.
- **Reading the log:** `iqRMS ≈ 0.85` with `dcI = dcQ ≈ 0.6` means all-zero buffers — the front-end is delivering
  nothing (cable, power, PortaPack not in HackRF mode). A real signal at sane gain sits well above that.
- **Gain:** radio defaults to LNA 24 / VGA 24 / amp OFF (the +14 dB amp overloads strong FM broadcast). ADS-B
  uses Mayhem's proven LNA 32 / VGA 32 / amp ON.

## Made by

RocketGod — [RocketGod.dev](https://rocketgod.dev) — for The Pirates' Plunder crew:
[discord.gg/thepirates](https://discord.gg/thepirates).

## Credits

Settings on both platforms carry a rolling credits window (PortaPack style) with Mayhem's own contributor
lists and, for every receiver, the authors named in the source files it was ported from (`web/src/credits.ts`
and `ui/Credits.kt` hold the same text). In short:

- **PortaPack Mayhem** — [portapack-mayhem/mayhem-firmware](https://github.com/portapack-mayhem/mayhem-firmware)
  (GPL-3.0). The app model, the theme palettes (`theme.cpp`), and the receivers ported here: `proc_flex.cpp`,
  `proc_pocsag2` / `pocsag.cpp` (the EccContainer BCH(31,21) corrector is a direct port), `proc_ais` /
  `ais_packet.cpp`, `proc_aprsrx` / `aprs_packet.hpp`, `proc_ert` / `ert_packet.cpp`, `proc_btlerx` (whitening and
  CRC), `proc_adsbrx`, Looking Glass and Search.
- **HackRF** — [greatscottgadgets/hackrf](https://github.com/greatscottgadgets/hackrf). The USB vendor protocol,
  gain ranges and board IDs come from libhackrf and the HackRF firmware (Great Scott Gadgets, Jared Boone,
  Michael Ossmann and contributors).
- **multimon-ng** — [EliasOenal/multimon-ng](https://github.com/EliasOenal/multimon-ng) (GPL-2.0). The FLEX
  decoder lineage behind Mayhem's `proc_flex` (Tom Sailer, Elias Oenal, Craig Shelley and contributors).
- **dump1090** — [antirez/dump1090](https://github.com/antirez/dump1090) (BSD). The Mode-S preamble / CRC / CPR
  approach the ADS-B decoder follows.
- **PDW** — the FLEX + POCSAG on one channel idea and the message line format.
- **Wardrive Go** — the author's earlier Android SDR app. The HackRF driver, SDR engine and
  ADS-B decoder started there.

## License

GPL-3.0 (see [`LICENSE`](LICENSE)). Mayhem firmware is GPLv3 and this app ports its DSP/UI model, so the
port is GPLv3 too; the SDR code lifted from Wardrive Go is the same author's and is relicensed
here under GPLv3.

## 🤝 Community

Join **The Pirates' Plunder** on Discord:

➡️ **[https://discord.gg/thepirates](https://discord.gg/thepirates)**

<img width="1500" height="1000" alt="rocketgod_logo_transparent" src="https://github.com/user-attachments/assets/b14191a5-b509-44c4-be17-ad51e3226ec8" />
