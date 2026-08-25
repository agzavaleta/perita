import { readFile } from "node:fs/promises"

const manifest = JSON.parse(await readFile(new URL("../dist/manifest.webmanifest", import.meta.url), "utf8"))
const serviceWorker = await readFile(new URL("../dist/sw.js", import.meta.url), "utf8")
const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8")

function assert(condition, message) {
  if (!condition) throw new Error(`PWA verification failed: ${message}`)
}

assert(manifest.id === "/", "manifest id")
assert(manifest.start_url === "/?source=pwa", "standalone start URL")
assert(manifest.display === "standalone", "standalone display")
assert(manifest.icons.some((icon) => icon.sizes === "192x192"), "192px icon")
assert(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "any"), "512px icon")
assert(manifest.icons.some((icon) => icon.purpose === "maskable"), "maskable icon")
assert(serviceWorker.includes("index.html"), "offline navigation shell")
assert(serviceWorker.includes("perita-192.png"), "static icon precache")
assert(serviceWorker.includes("apple-touch-icon-v2.png"), "Apple touch icon precache")
assert(serviceWorker.includes("SKIP_WAITING"), "controlled update message")
assert(!/indexedDB|deleteDatabase|perita_mobile/.test(serviceWorker), "service worker must not access application data")
assert(html.includes('href="/apple-touch-icon-v2.png"'), "Apple touch icon")
assert(html.includes("viewport-fit=cover"), "safe-area viewport")

console.log("PWA verification passed: manifest, offline shell, controlled update, icons, and data isolation.")
