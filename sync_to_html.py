#!/usr/bin/env python3
"""
sync_to_html.py — regenerate index.html from the canonical Perita.jsx

Usage:
    python3 sync_to_html.py

Run this from the project folder (where Perita.jsx and index.html live)
after any edit to Perita.jsx. It rebuilds only the <script type="text/babel">
block inside index.html; everything else (head, CDN scripts, PWA/manifest
tags, the perita-core.js <script> tag, the service-worker bootstrap) is
preserved as-is.
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
JSX_PATH = os.path.join(BASE_DIR, 'Perita.jsx')
HTML_PATH = os.path.join(BASE_DIR, 'index.html')

jsx = open(JSX_PATH, encoding='utf-8').read()
html = open(HTML_PATH, encoding='utf-8').read()

babel_tag = '<script type="text/babel">'
bs = html.find(babel_tag)
if bs == -1:
    raise SystemExit(f'Could not find {babel_tag!r} in {HTML_PATH}')
head = html[:bs]

jsx_body = jsx.replace('/* Perita v1.0.0 — App.jsx */\n', '')

# Remove CSS injection block (CSS lives in <style> in index.html's head instead)
css_s = jsx_body.find('\n// ── Inject app CSS')
css_e = jsx_body.find('\ndocument.head.appendChild(_styleEl);\n') + len('\ndocument.head.appendChild(_styleEl);\n')
if css_s > 0:
    jsx_body = jsx_body[:css_s] + jsx_body[css_e:]

# Remove the inline PERITA_LOGO constant (index.html sets window.PERITA_LOGO
# separately in its head) and point the <img> at the window global instead.
logo_s = jsx_body.find('\nconst PERITA_LOGO = "')
logo_e = jsx_body.find('";', logo_s) + 2
if logo_s > 0:
    jsx_body = jsx_body[:logo_s] + jsx_body[logo_e:]
    jsx_body = jsx_body.replace('src={PERITA_LOGO}', 'src={window.PERITA_LOGO}')

# Swap the ESM export for a ReactDOM bootstrap (index.html has no bundler).
jsx_body = jsx_body.replace(
    '\nexport default App;\n',
    "\nReactDOM.createRoot(document.getElementById('root')).render(<App />);\n"
)

sw_start = html.rfind("<script>\nif ('serviceWorker'")
if sw_start == -1:
    raise SystemExit('Could not find the service-worker bootstrap script in index.html')
sw_end = html.find('</script>', sw_start) + len('</script>')
sw_script = html[sw_start:sw_end]

new_html = head + babel_tag + '\n' + jsx_body + '\n</script>\n' + sw_script + '\n</body>\n</html>\n'

open(HTML_PATH, 'w', encoding='utf-8').write(new_html)
print(f'Regenerated {HTML_PATH} ({len(new_html)} bytes) from {JSX_PATH}')
