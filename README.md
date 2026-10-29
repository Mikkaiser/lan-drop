# LAN Drop

Share a folder from your computer with anyone who has the link, right from the browser.

- **Host:** open the page in Chrome or Edge on a computer, click **Choose shared folder…**, and share the code, link or QR code. Keep the tab open while sharing.
- **Everyone else:** open the link (or enter the code) on any device. Download files from the host's folder and drop files to upload them straight into it.

Files go directly between devices over WebRTC; nothing is uploaded to a server. The free public [PeerJS](https://peerjs.com) broker only introduces devices to each other, and its relay is used only when a direct connection isn't possible.

The share code stays the same when the host reloads or switches networks, and guests reconnect on their own.

## Notes

- Anyone with the code can see, upload and delete files in the shared folder. Use **New code** to disconnect everyone.
- Only top-level files are shared (not subfolders).
- Picking a folder needs the File System Access API (Chrome/Edge desktop). Guests can use any modern browser.

## Run locally

Any static file server works, e.g.:

```
python -m http.server 5173
```
