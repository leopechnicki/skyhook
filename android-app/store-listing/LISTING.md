# SKYHOOK - Google Play store listing (main store listing, English UK)

Copy-paste source for Play Console -> Grow -> Store presence -> Main store
listing. Every field below is within Play's limit (checked by
`node scripts/listing-check.mjs`, which fails on overflow so the limits are
tested rather than remembered). Art in this folder is generated from the
game's own renderer by `scripts/store-assets.mjs`; screenshots are real
frames captured from the signed release build (`skyhook-1.1.0-vc2-release-universal.apk`,
production config, no staging banner) on the API 35 Pixel 6 emulator
(`screenshots/`, see `../PLAYSTORE_READY_REPORT.md` for how).

## App name (max 30)

    SKYHOOK

## Short description (max 80)

    One-touch neon arcade: orbit, let go, hook the next planet and climb higher.

## Full description (max 4000)

    SKYHOOK is a one-touch arcade climber. Your rocket is tethered to a planet and swinging around it. Tap to fire the thruster and let go: you fly straight, and the next planet or star you pass near catches you. Release at the right moment to line up the next hook. Miss everything and you drift out of the column - or, higher up, clip a meteoroid - and the run ends.

    ONE INPUT, REAL ORBITS
    Every body has its own mass and radius, and your orbit follows Kepler's laws from them. A star spins you faster and slings you almost twice as far as a small planet, so the same tap does very different things depending on what you are holding. The tighter you catch a body, the faster it spins you. The hull always points where you will fly, so the launch line is readable off the ship itself.

    CLIMB
    The camera only ever goes up. Every hook raises the floor beneath you, and the sky gets heavier the higher you go: more stars, tighter release windows, amber planets that crumble under you after a moment, and tumbling meteoroids from the twelfth body up. Idling on an orbit is always safe. There is no timer. Only a sloppy release or a meteoroid ends a run.

    SCORE
    Tight hooks score more and build a combo multiplier up to x9. Gold shards drift between bodies for the brave. Your best score is saved on your device.

    CUSTOMISE YOUR SHIP
    Paint the nose, window, body and fire of your rocket from a palette of twelve neon colours. The gold hull is reserved for whoever holds first place on the global leaderboard.

    OPTIONAL GLOBAL LEADERBOARD
    Playing needs no account and no internet. If you want to compete, create an account with an email address and a public username and every finished run goes on the worldwide board. Runs are checked automatically for bot play so the top of the board stays human. You can change your username, and you can have your account and everything with it deleted at any time.

    NO ADS. NO PURCHASES. NO TRACKING.
    SKYHOOK shows no advertisements and contains no in-app purchases. It does not use analytics or advertising SDKs and does not read your advertising ID. The only permission it needs is internet access, and only for the optional leaderboard. Read the full privacy policy at https://skyhookplay.com/privacy.html.

    Also playable in any browser at https://skyhookplay.com - the same game, the same leaderboard.

## Category, tags, contact

| Field | Value |
|---|---|
| App or game | Game |
| Category | Arcade |
| Tags (up to 5) | Arcade, Casual, Single player, Offline, Physics |
| Contact email | leopsantos@hotmail.com |
| Website | https://skyhookplay.com |
| Privacy policy URL | https://skyhookplay.com/privacy.html |
| Default language | English (United Kingdom) - en-GB |

## Graphics (this folder)

| Asset | File | Play spec | Actual |
|---|---|---|---|
| App icon | `icon-512.png` | 512x512 PNG, 32-bit, no transparency, <= 1 MB | 512x512, opaque |
| Feature graphic | `feature-graphic-1024x500.jpg` | 1024x500 JPEG or 24-bit PNG (no alpha), <= 15 MB | 1024x500 JPEG (a canvas export is always RGBA PNG, which Play rejects here) |
| Phone screenshots | `screenshots/phone-0N-*.png` | 2-8, 24-bit PNG or JPEG (no alpha), 320..3840 px each side, longer side at most 2x the shorter; 9:16 at >= 1080x1920 to be eligible for promotion | 1080x1920 (9:16), 24-bit PNG, real frames |

The emulator's Pixel 6 panel is 1080x2400 (9:20), which Play rejects: the
longer side may be at most twice the shorter. Each screenshot is therefore the
raw `screencap` frame cropped to rows 240..2160 - that drops the Android
status bar and the gesture bar and nothing of the game (the HUD starts below
row 240 and the lowest button ends above row 2160) - and flattened to 24-bit
RGB, because Play refuses PNGs with an alpha channel. Nothing is scaled,
retouched or composited. `scripts/listing-check.mjs` fails the build if a
screenshot is not 1080x1920 RGB.

Tablet screenshots (7" and 10") are optional and not provided: the game is
portrait-only and the app is declared for phones. If Play asks for them the
phone shots can be uploaded there too.

## Not needed for this listing

- Promo video: optional, none.
- TV / Wear / Chromebook assets: the app does not target them.
