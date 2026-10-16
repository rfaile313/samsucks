<p align="center">
  <picture>
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/lockup-horizontal-dark-1920x640.png">
    <img src="assets/brand/lockup-horizontal-light-1920x640.png" alt="SamSUCKS" width="560">
  </picture>
</p>

<p align="center">
  <b>A Plex client for Samsung TVs that doesn't suck.</b><br>
  Smooth scrolling, hardware playback, zero dependencies.
</p>

<p align="center">
  <img src="assets/readme/home.png" alt="SamSUCKS home screen" width="880">
</p>

The official Plex app on Samsung TVs is painfully slow. The same library flies on a
Fire TV or an Apple TV, so the TV isn't the problem; the app is.

On my 75" Samsung Q60B (2022, Tizen 6.5):

| | Official Plex app | SamSUCKS |
| --- | --- | --- |
| Opening the app | about a minute | about a second |
| Typing in search | every letter lags | instant |
| Search results | take forever | appear as you type |

The Plex server answers a search in 30–150 ms, so the server was never the bottleneck.

SamSUCKS is a from-scratch Plex client for Samsung's Tizen TVs, built for speed:

- **Smooth.** About 50 fps while scrolling, with a 17 ms median frame, measured on a 2022 Samsung Q60B.
- **Hardware playback.** It plays files directly through Samsung's video decoder.
  On a real 3,952-item library, 98.7% plays without any transcoding.
- **Quick to start.** Home appears in under a second, and video starts about a second after you press play.
- **Tiny.** Plain JavaScript, no framework, no npm, no build step.

## Install

You need:
- a Samsung smart TV running Tizen 6.0 or newer, which is 2021 or newer
  (tested on a 2022 Q60B and a 2021 Q70A),
- a Mac or Linux computer on the same network as the TV,
- a Plex Media Server.

**1. Download SamSUCKS**

```sh
git clone https://github.com/rfaile313/samsucks.git
cd samsucks
```

**2. Run setup**

```sh
./scripts/setup.sh
```

This installs Samsung's command-line tools (about 270 MB), finds your TV on the
network, and creates a signing certificate. If Developer Mode isn't turned on yet,
it stops and tells you exactly what to do, including your computer's IP address.
The steps are also below. Run it again afterwards, and it picks up where it left off.

**3. Install it on the TV**

```sh
./scripts/deploy.sh
```

SamSUCKS opens on the TV. Go to **[plex.tv/link](https://plex.tv/link)** on your phone
or computer and type the code it shows, or scan the QR code. That's it.

<details>
<summary><b>Turning on Developer Mode</b></summary>

1. Press **Home** on the remote and open **Apps**.
2. On the Apps screen, type **1 2 3 4 5** on the remote.
   - No number keys? Press the **123** button to bring up the on-screen keypad.
   - Nothing happened? Try again, typing a bit faster.
3. Switch **Developer mode** to **On**, and enter your computer's IP address
   (`./scripts/setup.sh` prints it).
4. Choose **OK**, then restart the TV: hold the **Power** button until it turns off and back on.

When it's on, the Apps screen shows **Develop mode** at the top.
</details>

### Opening it later

Press **Home** → **Apps** and scroll to the bottom, where your installed apps are.
To pin it to the home bar, highlight **SamSUCKS**, open its options (hold **OK**) and
choose **Add to Home**.

### Troubleshooting

| Problem | Fix |
| --- | --- |
| Typing 12345 does nothing | Make sure you're on the **Apps** screen. Use the on-screen keypad (**123** button) if your remote has no number keys, and type quickly. |
| Setup says "No Samsung TV found" | Turn the TV on and make sure it's on the same network (Wi-Fi or Ethernet) as your computer. |
| Setup says Developer Mode points at another IP | Re-enter your computer's IP in the Developer Mode popup, then restart the TV. |
| "Can't reach the TV" when deploying | Restart the TV, then run `./scripts/setup.sh` again. Your computer's IP may have changed. |
| The app disappeared | TV firmware updates can remove sideloaded apps. Run `./scripts/deploy.sh` again. |
| The sign-in code expired | Press **OK** on the sign-in screen for a new code. |

## Using it

| Remote | What it does |
| --- | --- |
| Arrows / OK | Move around / select |
| Play/Pause | Play whatever is focused, or pause and resume |
| Back | Go back (while watching, the first press hides the controls) |
| ▼ while watching | Audio and subtitle tracks |
| ◀ ▶ while watching | Seek; hold to go faster |
| Yellow | Change the sort order in a library |
| CH ▲ / CH ▼ | Jump by letter in a library |

What's in it: home rows (Continue Watching, On Deck, Recently Added…), full library
grids, search with the TV keyboard, movie and show pages with seasons and episodes,
resume and mark watched, audio and subtitle picker (including external `.srt` files),
up-next autoplay, and watch progress synced back to Plex.

## Why it's fast

Samsung TVs only run web apps, but there's nothing slow about the web engine
if you treat it like a game engine:

- Every animation is a GPU transform or fade. Nothing big is ever repainted.
- Lists reuse a fixed set of tiles instead of creating new ones as you scroll.
- The focus ring never moves. The content slides under it.
- A held-down key can never queue up work: input is applied at most once per frame.
- Plex resizes every image to exactly the pixels on screen before it's sent.
- Video goes straight to Samsung's hardware decoder. Only what the TV can't decode
  (mostly DTS audio) is converted by Plex, and the video itself is never re-encoded.

The biggest win was one line of CSS:

<p align="center">
  <img src="assets/readme/frame-trace.png" alt="Frame times for the same 12 button presses: the old renderer froze for about 2 seconds on every press and took 24.4 s; SamSUCKS finished in 3.7 s and never went above 66 ms" width="760">
</p>

A full-screen CSS gradient behind the UI took **almost two seconds** to repaint on the
TV's CPU. Now the background is a 2×2-pixel WebGL texture that the GPU stretches to
fill the screen: it looks the same and costs nothing. Want to see the difference?
**Settings → Demo: original slow renderer** brings the old one back, and
**Settings → Performance overlay** shows the frame rate.

## For developers

<details>
<summary><b>Dev loop: logs, remote control and benchmarks on the real TV</b></summary>

Chrome DevTools can't attach to a retail TV, so dev builds talk to a small server on
your computer instead. Put your computer's `host:port` in `.env` as `DEV_HOST`, then:

```sh
node tools/devserver.mjs          # receives logs and perf samples from the TV (build/tv.log)
./scripts/deploy.sh --dev         # dev build: performance overlay, logging, remote control

curl 'localhost:8790/send?keys=down,right,right,enter'       # press buttons
tools/tveval.sh 'document.title'                              # run JS on the TV, print the result
tools/tveval.sh '__bench(["right","right","left","left"], 250)'   # frame stats while replaying keys
tools/tveval.sh "__css('.hero-art{display:none}')"           # A/B test a CSS change live
```

With `DEV_SKIP_LOGIN=1` and `PLEX_SERVER_URL` in `.env`, dev builds skip sign-in and
use a server that allows unauthenticated local-network access.

The UI also runs in desktop Chrome: `./scripts/deploy.sh --build-only`, then serve
`build/app/` with any static server. It uses a `<video>` element instead of AVPlay there.
</details>

<details>
<summary><b>How the code is laid out</b></summary>

```
app/            the whole TV app; deploy.sh copies it to build/app and packages it
  js/screens/   home, library, detail, player, search, settings, login
  js/ui/        rows, grids, tiles, image loader, backdrop, perf overlay
  js/plex/      plex.tv sign-in and Plex Media Server API
  js/platform/  Tizen keys and device info, AVPlay / <video> player
scripts/        setup.sh (one-time) and deploy.sh (build + install)
tools/          dev server, TV eval, network remote
```

There's no bundler on Tizen 6.5 and newer. The TV's browser runs ES modules natively,
and `deploy.sh` adds `<link rel="modulepreload">` tags so every module loads in parallel
(about 0.9 s cold start, versus 0.8 s for a minified bundle).

Tizen 6.0 (2021 TVs, Chromium 76) refuses to load modules from an app's `file://`
origin, so the app sticks on its splash screen. `deploy.sh` asks the TV for its Tizen
version and, below 6.5, bundles the modules into one classic script with esbuild
(via `npx`, so those TVs need Node.js on the computer you deploy from). Force it with
`--bundle`.
</details>

<details>
<summary><b>Performance notes</b> (measured on a 2022 Q60B, Tizen 6.5, Chromium 85)</summary>

| Background renderer | fps while navigating | worst frame |
| --- | --- | --- |
| Full-screen CSS `radial-gradient` | 11 | 1,928 ms |
| 2×2 2D canvas, stretched by CSS | 20 | 207 ms |
| 2×2 WebGL canvas, stretched by the compositor | 49–50 | 80 ms (17 ms median) |

Ruled out by A/B testing on the TV: hero image masks, the focus ring's shadow,
poster fade-ins, row opacity changes, and per-tile compositor layers. None made a
measurable difference.
</details>

<details>
<summary><b>Plex server quirks</b></summary>

- Plex Media Server 1.42 returns `400` for `start.m3u8` unless
  `/video/:/transcode/universal/decision` was called for the same session first.
- `X-Plex-Platform=Tizen` selects the server's built-in profile for the official app,
  which rejects these transcode requests, so SamSUCKS identifies itself as `Samsung`.
- Samsung TVs from 2018 on can't decode DTS. For those files Plex copies the video
  and converts only the audio, to AC3 5.1.
</details>

## Credits

Inspired by [plx-native](https://github.com/GLinnik21/plx-native), a native Plex client
for LG TVs. Fonts: [Inter](https://rsms.me/inter/) and
[Barlow Condensed](https://fonts.google.com/specimen/Barlow+Condensed) (SIL Open Font
License). QR codes: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
by Kazuhiko Arase (MIT).

SamSUCKS is an independent project, not affiliated with Plex or Samsung.

## License

Copyright © 2026 rfaile313. SamSUCKS is free software, released under the
[GNU General Public License v3.0](LICENSE): you can use, study, change and share it,
and anything you distribute that's built on it must stay open source under the same
license.
