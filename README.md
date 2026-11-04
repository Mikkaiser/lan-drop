# LAN Drop

Share a folder from your computer with anyone who has the link, right from the browser. No install, no account, and the files never get stored on a server.

**Live:** https://mikkaiser.github.io/lan-drop/

## How it works in 50 seconds

[![How LAN Drop works: watch the 50-second video](how-lan-drop-works.jpg)](https://mikkaiser.github.io/lan-drop/how-lan-drop-works.mp4)

*Click the image to play the video.* It's also on the site: **How LAN Drop works**, in the footer.

## Using it

- **Host:** open the site in Chrome or Edge on a computer, click **Choose shared folder…** and allow editing. Share the 6-letter code, the link or the QR code. Keep the tab open while sharing.
- **Everyone else:** open the link, scan the QR code or type the code, on any device and in any modern browser. Download files from the host's folder, or drop files on the page to upload them straight into it.
- **Who's connected:** the host's top right shows how many people are connected, their device (e.g. "iPhone · Safari") and their IP address, marked "via relay" when their connection goes through the relay.
- **Coming back:** reopen the site, or your own share link, in the same browser and click **Resume sharing**. The code stays the same, so links people already have keep working. If Chrome remembers the folder permission ("Allow on every visit"), sharing resumes on its own.
- **New code** disconnects everyone and makes a fresh code. **Stop sharing** ends the share.

| | Host a folder | Join a share |
|---|---|---|
| Chrome, Edge, Brave, Opera, Vivaldi, Arc on a computer | ✅ | ✅ |
| Firefox, Safari | ❌ (no File System Access API) | ✅ |
| Phones and tablets | ❌ | ✅ |

## How it works

```mermaid
flowchart LR
  H["Host browser<br/>(shared folder)"]
  G["Guest browser"]
  B["PeerJS broker<br/>introduces the devices"]
  W["Relay Worker<br/>relay.mikkaiser.com"]
  T["Cloudflare TURN relay"]

  H -. "1 · register code" .-> B
  G -. "2 · find code" .-> B
  G -- "3 · direct connection (when the network allows)" --- H
  H -. "relay pass" .-> W
  G -. "relay pass" .-> W
  G == "4 · otherwise through the relay (end-to-end encrypted)" === T
  T === H
```

1. **The folder stays on the host's computer.** The host's page reads and writes it through the browser's File System Access API. Guests' uploads are written straight into it, and files added in Explorer or Finder show up for everyone within about 2 seconds.
2. **The broker only introduces devices.** The free public [PeerJS](https://peerjs.com) broker matches a guest to the host's code and passes along the connection setup. No file data goes through it.
3. **WebRTC tries a direct connection first.** On networks that allow it, devices talk to each other directly.
4. **Otherwise the data goes through a relay.** Many staff and guest Wi-Fi networks block devices from reaching each other. Then the data goes through Cloudflare's TURN relay. Transfers are encrypted from one browser to the other (DTLS), so the relay only passes along data it can't read.

The share code stays the same when the host reloads or switches networks, and guests reconnect on their own.

## Speed

One WebRTC connection only keeps a limited amount of data in flight, which caps its speed on long or lossy routes such as the relay. So:

- **4 connections per guest.** Each guest opens one control connection plus three extra "lanes" to the host. The host still counts the guest once.
- **4 MB segments.** Each file is split into 4 MB segments spread across the lanes, with two segments moving on each lane at a time. Both sides write every segment at its exact position in the file.
- **Recovery.** If a lane drops, its unfinished segments are sent again on the others.
- **Compatibility.** Pages that are still running an older cached version fall back to a single connection, in both directions.
- **Visible speed.** Every transfer shows its average speed, e.g. "45% · 2.3 MB/s".

Limits that no app can get around: across different networks, speed can't exceed the sender's upload or the receiver's download. When two devices on the same network have to use the relay, every file goes out to the internet and back in, so it can't reach local network speed.

## The relay (`worker/`)

A browser has to hold relay credentials itself, because the browser connects to the relay directly. `worker/` is a Cloudflare Worker that gives each visitor short-lived credentials (valid for 3 hours), so the long-lived TURN key never appears in the public page.

- **Bot check:** the Worker only issues credentials to requests carrying a valid [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/) token from this page. Real visitors normally see nothing; a checkbox appears only if Turnstile insists. Scripts that fake the `Origin` header are refused. Embedded or automated browsers may fail the check; they then only get direct connections.
- **Spending guard:** before issuing credentials, the Worker reads the account's TURN usage (ingress + egress, last 31 days). It stops at `RELAY_LIMIT_GB` (900 GB), below Cloudflare's free 1,000 GB a month. If it can't read usage, it refuses (fail closed).
- **Three addresses, all tried at once:** `relay.mikkaiser.com` (custom domain), `lan-drop-relay.pages.dev` (`relay-proxy/`, a Pages project that only forwards to the Worker through a service binding) and `lan-drop-turn.mikkaiser-ribeiro.workers.dev`. Some networks block the Cloudflare addresses the last two resolve to; the custom domain gets addresses they can reach.
- **Public IP:** the Worker also tells each browser its public IP, which the host's list shows. Browsers hide local network IPs from web pages.

| Setting | Kind | What it is |
|---|---|---|
| `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` | Secret | Cloudflare **Realtime → TURN Server** key |
| `ANALYTICS_API_TOKEN` | Secret | API token with **Account Analytics: Read**, for the spending guard |
| `TURNSTILE_SECRET` | Secret | Turnstile widget's Secret Key. Delete it to turn the bot check off. |
| `ALLOWED_ORIGINS`, `ACCOUNT_ID`, `RELAY_LIMIT_GB` | Var in `worker/wrangler.toml` | Allowed sites, account to read usage from, spending limit |

Secrets live only in Cloudflare; none are in this repository.

## Project layout

| Path | What it is |
|---|---|
| `index.html`, `app.js` | The whole site: UI, host and guest logic, transfer protocol |
| `how-lan-drop-works.mp4`, `.jpg` | The 50 s explainer video (1080p, 1.8 MB) and its poster; the footer link loads the video only when opened |
| `fonts/` | Barlow and IBM Plex Mono, self-hosted |
| `favicon.svg`, `favicon-*.png` | Site icon: an arrow dropping into a tray |
| `worker/` | Relay Worker: credentials, bot check, spending guard |
| `relay-proxy/` | Pages forwarder giving the Worker a second address |

## Look

The site and the video share one visual identity, "Broadside": an ink-black ground (`#111111`), cream text (`#F0ECE5`) and fire-orange (`#E85D26`) as the only accent. Headings are heavy lowercase Barlow; labels and buttons are uppercase IBM Plex Mono. Everything is flat and square, with 1 px hairlines and no shadows or rounded corners.

The video was made with [HyperFrames](https://hyperframes.heygen.com) in a separate project (`~/projects/lan-drop-video` in WSL), with a local Kokoro voice and Pixabay sound effects. Only the finished MP4 and its poster live in this repository.

## Deploying

- **Site:** GitHub Pages serves `main`, so pushing is deploying.
- **Worker:** `npx wrangler deploy` in `worker/`. Set secrets with `npx wrangler secret put NAME`.
- **Forwarder:** `npx wrangler pages deploy --branch main` in `relay-proxy/`.
- **Settings in the page:** in `app.js`, `RELAY_URLS` lists the Worker's addresses and `TURNSTILE_SITE_KEY` holds the Turnstile Site Key (public by design). The site's origin must be in `ALLOWED_ORIGINS`.

## Run locally

Any static file server works, for example:

```
python -m http.server 5173
```

Turnstile only issues tokens on the widget's hostname, so locally the page asks for relay credentials without a token.

## Notes

- Anyone with the code can see, upload and delete files in the shared folder.
- Only files directly inside the shared folder are shared, not subfolders.
- The host must keep the tab open while sharing.
