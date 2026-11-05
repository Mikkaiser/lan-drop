LAN Drop Local: share a folder with everyone on the same network, with no internet needed. It works on a router with no internet, a phone hotspot without data, or two computers joined by an Ethernet cable.

## Download

| Computer | File |
|---|---|
| Windows | `lan-drop-local-windows-x64.exe` |
| Mac with Apple Silicon (M1 and later) | `lan-drop-local-mac-arm64.zip` |
| Mac with Intel | `lan-drop-local-mac-x64.zip` |
| Linux | `lan-drop-local-linux-x64.tar.gz` |

Only the computer that shares the folder needs the program. Everyone else just opens the address it shows, in any browser on any device.

## First run

- **Windows:** double-click the `.exe`. If SmartScreen says "Windows protected your PC", click **More info → Run anyway**; the program isn't code-signed. When Windows asks about the firewall, allow access, so others can connect.
- **Mac:** unzip, then **right-click → Open** the first time, and confirm; the program isn't notarized. It opens in Terminal.
- **Linux:** `tar xzf lan-drop-local-linux-x64.tar.gz && ./lan-drop-local-linux-x64`

Pick the folder to share, and LAN Drop Local opens in your browser with the address and a QR code for others. It remembers the folder next time. Keep the window open while sharing.

Options: `--folder <path>`, `--port <n>`, `--choose` (pick the folder again), `--no-open`.
