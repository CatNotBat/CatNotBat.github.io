# Notes for Lev (second pass, 2026-11-18)

## The idea now
The site is a radio. The `freq` readout is a real dial. Each station sits at the actual frequency of the thing it's about. Between stations you get static, and as you tune closer, a station's text climbs out of the noise.

| dial | station | why it's there |
|---|---|---|
| 50 Hz | the hum | Israeli mains. The wires at the top hum along with it, and you can pluck them |
| 53 | dns resolver | the port number, sitting right next to the hum. Shows a real query for `birds.fly`: it exists (rcode 0, two A records, looks parked). `agree` opens Better days |
| 440 Hz | a (pattern) | live-codeable music, see below |
| voice band | harmonium | audio band, where the OFDM modem lives |
| 1420.405 MHz | **hidden**: the hydrogen line | not in the presets. A hint toward gamma |
| 2.402 GHz | home | BLE advertising channel 37 |
| 24 GHz | roomsense | the radar |
| 480 THz | mugs | red light. Deliberately unexplained: just a snowy frame saying "no carrier" until there's a scan |
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

## 440 Hz: the pattern station (branch experiment/music-station)
An editable textarea in a small TidalCycles/Strudel-style mini-notation, interpreted by ~120 lines of my own JS (no library, no eval, no network).
`a b c` splits a cycle, `[a b]` squeezes into one slot, `<a b>` alternates per cycle, `a*4` repeats, `,` stacks, `~` is a rest, and each line is a layer.
Atoms: Hz values (50, 1420.405), notes (a4, c#5), plus `click chirp blip hum`. Each note sends a packet along the wires.
I chose not to embed Strudel itself: it's AGPL-3.0 (the whole site would have to be AGPL) and it fetches samples from the network (CSP).

## 160 MHz: rv32 (emulator)
`js/rv32.js` is a from-scratch RV32IM assembler and CPU. It runs `fw/beakless.S` (226 bytes): sleep, read h₂ through memory-mapped I/O, print it over serial, and when it hits 100, raise the heart GPIO (the page's red beat) and spend the hydrogen.
- `irradiate` feeds hydrogen while you hold it.
- `edit` lets anyone rewrite the assembly; `flash` re-assembles it, and errors name the line.
- Memory map: `0x60000000` uart, `+4` heart, `+8` h₂ (read the reserve, write it back), `+0xc` sleep in ms.

## Real recordings (nothing shows until they exist)
`data/manifest.json` names the files; `null` means use the synthetic or illustrated version.
- **Static between stations** (Pi + RTL-SDR):
  `rtl_power -f 88M:108M:20k -g 40 -i 1 -e 5m sweep.csv`, then
  `uv run tools/sdr_static.py sweep.csv --place "Tel Aviv" > data/static.json`, then set `"static": "static.json"`.
- **harmonium spectrum**: `uv run tools/wav_spectrum.py wire.wav > data/harmonium.json`, then set `"harmonium": "harmonium.json"`.
- **harmonium before/after audio**: two recordings of the same moment, e.g. `wire.m4a` (what Discord carries) and `voice.m4a` (what comes out the other side). Set `"harmonium_audio": { "wire": "wire.m4a", "voice": "voice.m4a" }`. A play button appears, and the modem toggle crossfades between the two.
  Use m4a or mp3 so Safari plays it.

## harmonium numbers station (done, no call needed)
The audio on the site is the real harmonium pipeline: Codec 2, WireGuard, the OFDM modem, then a simulated 64 kbps Opus channel, run offline with `harmonium selftest`. The voice reading the `birds.fly` bytes is macOS `say -v Samantha` (numbers stations often used synthetic voices).
The run had 0% voice loss and 0 failed modem frames. The caption says it's offline.
To swap in your own voice: record `tools/numbers.txt` as a voice memo, then
```
afconvert -f WAVE -d LEI16@48000 -c 1 memo.m4a numbers.wav
harmonium selftest --input numbers.wav --opus --output voice.wav --modem-output wire.wav
uv run tools/harmonium_take.py voice.wav wire.wav --start 3.8 --length 17.5 --voice-offset 0.96 --note "..."
```
(`--voice-offset` is the latency selftest prints. Pick `--start` / `--length` to cover one reading.)
