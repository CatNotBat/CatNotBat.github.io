# Notes for Lev (second pass, 2026-11-18)

## The idea now
The site is a radio. The `freq` readout is a real dial. Each station sits at the actual frequency of the thing it's about. Between stations you get static, and as you tune closer, a station's text climbs out of the noise.

| dial | station | why it's there |
|---|---|---|
| 50 Hz | the hum | Israeli mains. The wires at the top hum along with it, and you can pluck them |
| 53 | dns resolver | the port number, sitting right next to the hum. Shows a real query for `and.birds.fly`, answered NXDOMAIN |
| voice band | harmonium | audio band, where the OFDM modem lives |
| 1420.405 MHz | **hidden**: the hydrogen line | not in the presets. A hint toward gamma |
| 2.402 GHz | home | BLE advertising channel 37 |
| 24 GHz | roomsense | the radar |
| 480 THz | mugs | red visible light, for the squid tentacles. Honest "no carrier" until there's a scan |
| 3×10¹⁹ Hz | gamma | radiation fills the h₂ reserve, a Geiger counter counts up, then Better days |

**State** is interactive:
- `listening`: tuning, the default.
- `transmitting`: shows the contact panel ("say hi").
- `dormant`: the page goes dark. Moving around gathers signal, and when the reserve is full the heart restarts and Better days opens. Esc wakes it early.

**Game bits:**
- A log of stations found (`log 3/8`) that persists in localStorage.
- Station dots on the presets once you've found them.
- A `last beat` timestamp remembered across visits.
- Arrow keys anywhere on the page jump between stations.
- A console hello.
- The NXDOMAIN 404 page.
- Opt-in synthesized sound: static between stations; per station, mains hum, modem beeps, OFDM tones, a hydrogen sine, an FMCW radar chirp, a BLE blip, and Geiger clicks. All Web Audio, no files.

Better days triggers: gamma, dormant, typing `fly`, the footer `signal: dormant`, the `wake it` button, or `#better-days` in the URL.

## Copy
Rewritten to drop titles and taglines: plain descriptions of what each thing does, in first person. **This is me guessing at your voice.** Edit freely. Lines that are my invention, so check them:
- "mostly to find out whether a dumb idea works"
- "too many ESP32s"
- "Right now it's drones talking MAVLink, point clouds". This comes from what you're working on; confirm you want it public.

The Better days story is untouched.

## Honest gaps
The harmonium spectrum is an illustration. The roomsense room is a schematic. Mugs: no scan yet. Handwriting slot: empty. `og.png`: missing.

## Verified
In the in-app browser at 1440 and 390, with no horizontal scroll:
- Tuning and the decode effect.
- The hidden station and log persistence.
- Gamma triggering Better days.
- Esc returns to home.
- Transmitting and dormant states.
- Hash deep links (`#dns` etc.).
- The 404 page.
- Zero JS errors.

**Not verified:**
- Sound (needs a real click and speakers).
- Safari and Firefox.
- Real phones (touch-dragging the dial).
- Reduced motion in a real browser.
- Lighthouse.
