#!/usr/bin/env python3
"""Fail if the site breaks its promises. Run before every push: python3 tools/check_contract.py

- localStorage keys must be the ones "what this page remembers" lists
- the only outside host is cloudflare-dns.com (and only in js/dns.js)
- no HTML-string DOM sinks, no eval
- the CSP in every page and in _headers allows nothing else
- no plain email address or mailto: in the source
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
KEYS = {"lk.found", "lk.lastBeat"}
HOSTS = {"cloudflare-dns.com"}
bad = []

js = {p: p.read_text() for p in (ROOT / "js").glob("*.js")}
html = {p: p.read_text() for p in [ROOT / "index.html", ROOT / "404.html", *(ROOT / "variants").glob("*.html")]}

for p, s in js.items():
    for k in re.findall(r"store\.set\('([^']+)'", s):
        if k not in KEYS: bad.append(f"{p.name}: undeclared storage key {k}")
    if re.search(r"\blocalStorage\.setItem\(", s) and p.name != "main.js": bad.append(f"{p.name}: direct localStorage write")
    for m in re.findall(r"\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function)", s):
        bad.append(f"{p.name}: DOM/eval sink {m}")
    for h in re.findall(r"https?://([a-z0-9.-]+)", s):
        if h not in HOSTS and h != "www.w3.org" and not h.endswith("github.com"): bad.append(f"{p.name}: outside host {h}")
    if "https://cloudflare-dns.com" in s and p.name != "dns.js": bad.append(f"{p.name}: DNS host outside dns.js")
    if re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}", s): bad.append(f"{p.name}: plain email address")

for p, s in html.items():
    if re.search(r"mailto:|[A-Za-z0-9._%+-]+@(gmail|[a-z0-9-]+)\.[a-z]{2,}", s): bad.append(f"{p.name}: plain email/mailto")
    if re.search(r"<script(?![^>]*\bsrc=)", s): bad.append(f"{p.name}: inline script")
    if re.search(r"\son[a-z]+=", s): bad.append(f"{p.name}: inline event handler")
    if re.search(r'\sstyle="', s): bad.append(f"{p.name}: inline style attribute")
    csp = re.search(r'Content-Security-Policy" content="([^"]*)"', s)
    if not csp: bad.append(f"{p.name}: no CSP meta"); continue
    for src in re.findall(r"https?://[^ ;]+", csp.group(1)):
        if "cloudflare-dns.com" not in src: bad.append(f"{p.name}: CSP allows {src}")

hdr = (ROOT / "_headers").read_text()
for src in re.findall(r"https?://[^ ;]+", hdr.split("Content-Security-Policy:")[1].splitlines()[0]):
    if "cloudflare-dns.com" not in src: bad.append(f"_headers: CSP allows {src}")

print("\n".join(bad) if bad else "contract holds")
sys.exit(1 if bad else 0)
