RANGILO RAAS 2026 - QR FIXED PROFESSIONAL BUILD

This build fixes the e-ticket QR display by serving each QR as a real PNG from the Node server instead of embedding a large data URL in the ticket HTML.

Folders:
- public/    Customer website + booking + ticket
- scanner/   Gate scanner
- admin/     Admin panel
- server/    Node/Express + Razorpay + QR generation

Run:
1. Open server folder in PowerShell.
2. Run: npm.cmd install
3. Run: npm.cmd start
4. Open: http://localhost:3000
5. Admin: http://localhost:3000/admin/
6. Scanner: http://localhost:3000/scanner/

QR:
- Ticket QR endpoint: /api/ticket/<TICKET_ID>/qr?mobile=<REGISTERED_MOBILE>
- QR contains signed ticket ID data used by the gate scanner.
- First valid scan = VALID ENTRY.
- Repeat scan = ALREADY SCANNED.

The server/.env file is included from the supplied project. Never share the Razorpay secret publicly.


PHONE/LAN SCANNER TEST
1. Keep the server window running.
2. Connect phone and laptop to the same Wi-Fi.
3. Run `ipconfig` on the laptop and find the active Wi-Fi IPv4 address.
4. On the phone open: http://<LAPTOP-IP>:3000/scanner/
5. If Windows Firewall asks whether Node.js can communicate on the network, allow it on Private networks.
6. IMPORTANT: camera access on a plain HTTP LAN address may be blocked by mobile Chrome because camera APIs generally require a secure context. If the scanner page opens but the camera is blocked, use the Ticket ID/QR image backup for local testing or deploy behind HTTPS for live phone-camera scanning.
