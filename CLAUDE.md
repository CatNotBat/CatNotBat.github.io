# catnotbat.github.io: working contract

Static site, no build step, no npm dependencies. `index.html`, `css/site.css`, `js/*.js` (ES modules).
Preview: `python3 -m http.server 4321 --bind 127.0.0.1` from this folder.

## Concept (do not dilute)
"Signal": a mostly dead instrument waiting for enough presence to restart. Dormant teal on near-black;
the only red is the heartbeat; dawn appears only inside the Better days dialog. Copy is from the build brief §4 and
the story is Lev's own words: reproduce it exactly, never edit it. Other copy: plain, first person, no titles or taglines, no bragging.

## Every change: the mirror loop
1. Screenshot at 390, 768 and 1440 wide. Look at them: what looks off, slop or off-brief? Fix the worst 1-3 issues, re-shoot. Stop after 3 rounds and ask Lev.
2. Drive the egg: type `fly` (needs real keydown events), the footer `signal: dormant` button, and the `disagree` button in ch 03.
   Check that Esc closes it, focus returns to the opener, and `#state` goes back to `listening`.
3. Reduced motion (`prefers-reduced-motion: reduce`): the reveal shows dawn and the story at once, and the wires render a single static frame.
4. Console: zero errors and zero CSP violations.
5. No horizontal page scroll at 320px (`document.documentElement.scrollWidth === innerWidth`).

## Rubric, 0-10 per axis; anything under 7 does not ship
Concept fidelity, craft, specificity & risk (strange/personal beats generic-but-clean), originality, performance + a11y.
The AI checks the floor. Lev decides on soul.

## Never
- Fabricate Lev's artifacts (scans, handwriting, captures, spectrograms). Leave a gap and ask.
- Add inline `<script>`/`<style>` (CSP forbids them) or third-party script hosts.
- Add Hebrew. Add all-caps tracked eyebrows, `A · B · C` strings, or arrows on links.
- Commit `*.pcap*`, `.env`, or secrets.

## Security gate before deploy
CSP meta present and unchanged in spirit; external links `rel="noopener noreferrer"`; email only assembled at runtime;
the only URL input accepted is the exact hash `#better-days`; `_headers` kept in sync if hosting moves to Cloudflare/Netlify.
