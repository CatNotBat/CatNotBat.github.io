# For whoever restores this

If you are reading this in 2050, or later, thank you for keeping it running.

## What must stay

- **The words of "Better days".** Five paragraphs, unedited, in `index.html`. Do not fix the typos you think you found.
- **The second and a half.** The ending falls for exactly 1500 ms. A body falls about 11 m in that time, close to the height of the walls of Jerusalem in the story.
- **Mostly dormant.** The page goes dark when left alone and wakes when touched. Making it always on breaks it.
- **Hidden stations stay hidden.** They are found by tuning, not by a menu.
- **Nothing phones home.** The only outside requests are the fonts and, only when someone presses resolve, one DNS question to 1.1.1.1.

## What may change

- **Fonts.** Fraunces and IBM Plex Mono, from Google Fonts. Host copies if the service is gone.
- **The DNS station.** It asks `cloudflare-dns.com` over DoH (RFC 8484). If that is gone, point it at any DoH resolver. If none exist, serve `data/dns-birds-fly.json`, a real capture from 18 November 2026, and say so on the page.
- **Browsers.** The page uses ES modules, `<dialog>`, Web Audio, canvas 2D and the Web Animations API. Emulate an older browser rather than rewriting for a newer one.

## What is real

- `data/harmonium-*.m4a` are real recordings of the harmonium project.
- `data/dns-birds-fly.json` is a real capture.
- `fw/beakless.S` is the firmware source shown on the 160 MHz station.
- The sunset time, the Voyager light-day and the CP 1919 period are computed or measured, not invented.

## What is not

- The pulsar click is a sonification of a measured period, not a recording.
- The colonies in the static are a simulation, reseeded daily.

## One unannounced day a year

The site stays dormant all day on one day each year, derived from a hash of the year in `js/main.js`. This is intended. The contact details stay readable.

November 2026
