# Play Store listing

Drafts for the Console. Limits are Google's: title 30, short description 80,
full description 4000 characters.

## Title (13/30)

```
Mayhem Mobile
```

## Short description (79/80)

```
Drive a HackRF from your phone: waterfall, demodulators and packet decoders.
```

## Full description (1847/4000)

```
Mayhem Mobile turns an Android phone into the screen and the signal processor for a
HackRF. Plug the radio into the USB-OTG port and the phone does the rest: raw 8-bit IQ
comes in over USB and the waterfall, demodulators and decoders all run on the handset.
No PortaPack screen is needed, and nothing is sent anywhere.

It is a port of the receivers from PortaPack Mayhem, rewritten in Kotlin against a
pure-userspace USB driver.

RECEIVE
• Audio — WFM, NFM, AM and SSB, with a slide-to-tune waterfall, squelch, bookmarks and
  a scanner
• ADS-B — Mode-S decoding with a live aircraft map and table
• AIS — vessel positions and names on 162 MHz
• APRS — Bell 202 AFSK packet radio on 144.39 MHz
• FLEX and POCSAG — pager traffic, both on one channel
• ERT — utility meter telemetry on 915 MHz
• TPMS — tyre-pressure sensors on 315 and 433 MHz
• ACARS — aircraft messages on 131 MHz
• BLE — Bluetooth advertising on 2.4 GHz
• Sub-GHz — weather stations, remotes and sensors, rtl_433 style

ANALYSE
• Looking Glass — a wideband sweep waterfall
• Search — find what is active across a band
• Capture — record raw IQ to a file for later

TRANSMIT
The transmit tools are switched off by default and stay off until you turn them on.
Transmitting is regulated nearly everywhere: use a band you are licensed for, a correctly
rated antenna or a dummy load, and check your local rules first. You are responsible for
what you send.

WHAT YOU NEED
• A HackRF One, HackRF Pro, Jawbreaker or rad1o
• A USB-OTG cable and a phone that supplies bus power
• An antenna for the band you want to listen to
A PortaPack is not required. If your HackRF has one attached, put it in HackRF mode.

OPEN SOURCE
GPL-3.0. The full source is linked below, along with a browser version that runs the same
DSP over WebUSB and adds a few apps this one does not have yet.

PRIVACY
No accounts, no analytics, no advertising and no tracking. Location permission is used on
the device to centre the map and as the reference for decoding aircraft positions; it is
never transmitted. The only network traffic is map tiles.

Not affiliated with Great Scott Gadgets.
```

## Links and metadata

| Field | Value |
|---|---|
| Category | Tools |
| Website | https://rocketgod-git.github.io/mayhem-mobile/ |
| Privacy policy | https://rocketgod-git.github.io/mayhem-mobile/privacy.html |
| Contact email | set in the Play Console (Play refuses to commit a listing edit without one) |
| Tags | SDR, radio, scanner, ADS-B, HackRF |

## Graphics in this folder

| File | Use | Spec |
|---|---|---|
| `icon-512.png` | app icon | 512×512, no alpha; Play applies its own mask |
| `feature-graphic-1024x500.png` | feature graphic | 1024×500, no alpha |

Screenshots are still needed: 2–8 phone shots, each at least 1080 px on the long edge.
An emulator cannot show live signals — it has no HackRF — so the receiver screens would
appear empty. Photographs or screen recordings from a phone with the radio attached make
a far better listing.

## Data safety answers

The form asks what the app collects or shares, meaning what leaves the device.

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | No |
| Location | Used on-device only, never collected or transmitted |
| Is all data encrypted in transit? | Not applicable — no data is sent |
| Can users request data deletion? | Not applicable — nothing is stored off-device |

Recorded IQ files and decoded packet logs stay in the app's own storage and are removed
with the app.
