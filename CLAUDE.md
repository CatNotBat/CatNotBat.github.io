# catnotbat.github.io: working contract

Static site, no build step, no npm dependencies. `index.html`, `css/site.css`, `js/main.js`, `js/dither.js`, `js/rv32.js`.
Preview: `python3 -m http.server 4321 --bind 127.0.0.1` from this folder. Tools in `tools/` are uv scripts (ruff clean).

## Concept (do not dilute)
The site is a radio. A dial with stations at the real frequency of each thing (see NOTES.md). Between stations: static,
and text climbs out of the noise as you tune in. Dormant teal on near-black; the only red is the heartbeat; dawn only
inside the Better days dialog. The story is Lev's own words: reproduce it exactly, never edit it.
Copy: minimal, plain, first person, no titles, taglines or bragging. Leave things unexplained; Lev prefers mystery.

## Every change: the mirror loop
1. Screenshot at 390, 768 and 1440 wide. Fix the worst 1-3 issues, re-shoot. Stop after 3 rounds and ask Lev.
2. Drive Better days: type `fly` (needs real keydown events), the footer `signal: dormant`, `agree` (dns), `wake it` and
   holding gamma. Esc closes it, focus returns to the opener, the dial goes home.
3. Tune every preset and the hidden station; check the scramble resolves and the readout locks.
4. Interactive stations: 440 (edit a line while it plays, the playhead follows), 160 MHz (breakpoint, poke a register,
   continue), roomsense (walk in and out of the room; tap to change what you carry).
5. Reduced motion: no glides or jitter, the reveal shows dawn and the story at once.
6. Console: zero errors and zero CSP violations. No horizontal page scroll at 320px.

## Never
- Fabricate Lev's artifacts. Real data goes through `data/manifest.json`; `null` means show the honest fallback.
- Add inline `<script>`/`<style>` (CSP forbids them) or third-party script hosts.
- Add Hebrew. Add all-caps tracked eyebrows, `A · B · C` strings, or arrows on links.
- Commit `*.pcap*`, `.env`, or secrets. Never publish anything that reveals when Lev is home.

## Security gate before deploy
CSP meta present; external links `rel="noopener noreferrer"`; email only assembled at runtime; the URL hash is checked
against a fixed set of station ids; `_headers` kept in sync if hosting moves to Cloudflare.
