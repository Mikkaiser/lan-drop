# LAN Drop

Share a folder from your computer with anyone who has the link, right from the browser.

- **Host:** open the page in Chrome or Edge on a computer, click **Choose shared folder…**, and share the code, link or QR code. Keep the tab open while sharing.
- **Everyone else:** open the link (or enter the code) on any device. Download files from the host's folder and drop files to upload them straight into it.

Files go directly between devices over WebRTC; nothing is stored on a server. The free public [PeerJS](https://peerjs.com) broker only introduces devices to each other.

When a network blocks direct connections between devices (common on staff/guest Wi-Fi), data goes through a Cloudflare TURN relay instead. It stays end-to-end encrypted, so the relay can't read it.

The share code stays the same when the host reloads or switches networks, and guests reconnect on their own. The host sees who is connected (device, and public IP — browsers hide local network IPs).

## Relay (worker/)

`worker/` is a Cloudflare Worker that hands browsers short-lived TURN credentials, so the TURN key never appears in this public page. It also guards spending: it reads the account's TURN usage and stops issuing credentials at `RELAY_LIMIT_GB` (900 GB, ingress + egress, last 31 days), below Cloudflare's free 1,000 GB/month. If usage can't be read, it refuses (fail closed) and LAN Drop falls back to direct connections only.

```
cd worker
npx wrangler deploy
npx wrangler secret put TURN_KEY_ID          # Realtime > TURN Server
npx wrangler secret put TURN_KEY_API_TOKEN
npx wrangler secret put ANALYTICS_API_TOKEN  # API token with Account Analytics: Read
```

`relay-proxy/` is a Cloudflare Pages project (`lan-drop-relay.pages.dev`) that only forwards to that Worker through a service binding. Some networks can't reach the Cloudflare addresses `*.workers.dev` resolves to, while `*.pages.dev` uses others; the page tries both at once. Deploy it with `npx wrangler pages deploy --branch main` from `relay-proxy/`.

List both URLs in `RELAY_URLS` in `app.js`, and the site's origin in `ALLOWED_ORIGINS` in `worker/wrangler.toml`.

## Hosting again after closing the tab

Reopen the site (or your own share link) in the same browser and click **Resume sharing** — the code stays the same, so links people already have keep working. If Chrome remembers the folder permission ("Allow on every visit"), sharing resumes on its own.

## Notes

- Anyone with the code can see, upload and delete files in the shared folder. Use **New code** to disconnect everyone.
- Only top-level files are shared (not subfolders).
- Picking a folder needs the File System Access API (Chrome/Edge desktop). Guests can use any modern browser.

## Run locally

Any static file server works, e.g.:

```
python -m http.server 5173
```
