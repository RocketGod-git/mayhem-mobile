# Play Store listing

The listing lives in `en-US/` and goes to Play with the **Play Listing** workflow
(`.github/workflows/play-listing.yml`): `read` prints what Play has now and saves its images,
`push` publishes `en-US/` in one edit. Edit the files here, not in the Console, so the two never drift.

| File | Field | Play's limit |
|---|---|---|
| `en-US/title.txt` | App name | 30 characters |
| `en-US/short-description.txt` | Short description | 80 characters |
| `en-US/full-description.txt` | Full description | 4000 characters |
| `en-US/website.txt` | Website | |
| `en-US/icon.png` | App icon | 512×512 PNG, no alpha; Play applies its own mask |
| `en-US/feature-graphic.png` | Feature graphic | 1024×500, no alpha |
| `en-US/phone/*.png` | Phone screenshots, in file-name order | 2–8, 9:16, at least 1080 px on the long edge |

Play rejects a title or short description that leans on "best", "#1", "free", prices, calls to
action or emoji, so keep those out.

Screenshots and the feature graphic are real captures of the app on a phone with a radio
attached. Nothing in them is drawn or mocked. An emulator has no radio, so its receiver screens are empty.

## Links and metadata

| Field | Value |
|---|---|
| Category | Tools |
| Website | https://rocketgod.dev/mayhem-mobile/ |
| Privacy policy | https://rocketgod.dev/mayhem-mobile/privacy.html |
| Contact email | set in the Play Console |
| Tags | SDR, radio, scanner, ADS-B, HackRF |

## Data safety answers

The form asks what the app collects or shares, meaning what leaves the device for the developer
or a third party.

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | No |
| Location | Used on the device only (map center, ADS-B position reference). Never sent. |
| Audio (microphone) | Push-to-talk only, straight to the radio. Never recorded or sent. |
| Is all data encrypted in transit? | Every lookup is HTTPS. No user data is sent. |
| Can users request data deletion? | Not applicable. Nothing is stored off the device. |

The optional lookups (aircraft details, callsigns, satellite orbits, map tiles) send only the
thing looked up, never anything about the user. They are listed in the privacy policy. Recorded IQ
files, decoded logs and the logbook stay in the app's own storage and are removed with the app.
