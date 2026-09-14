# Behnazrostami Course Platform

Private paid-course platform prototype.

## Included
- Username/password accounts with bcrypt hashing
- First-device lock per account; IP changes are allowed
- One active session per account
- Protected authenticated video endpoint
- Course and lesson management API
- Admin account creation, course creation and device reset
- Rate limiting and security headers
- Responsive Persian RTL student portal

## Demo
Username: `demo`
Password: `demo12345`

## Production notes
The current prototype uses in-memory data and local media storage so it can boot immediately. Before real paid sales, connect Postgres, persistent object storage/HLS, signed short-lived playback URLs, dynamic watermarking, payment verification, and a proper admin authentication flow. Browser websites cannot guarantee prevention of screenshots or external-camera recording; the player only provides best-effort deterrence such as download controls and watermarking.
