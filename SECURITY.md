# Security Policy

## Supported Versions

Security fixes are applied to the latest release only. Please keep the app
up to date.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security reports.

Report vulnerabilities privately through either channel:

- GitHub's [private vulnerability reporting](../../security/advisories/new)
  for this repository (preferred), or
- Email: shahfiq.dev@gmail.com

Include a description of the issue, reproduction steps, and the potential
impact. You can expect an acknowledgement within 7 days and a fix or a
reasoned response within 30 days.

## Scope Notes

hulesa is a local-first desktop app:

- S3 credentials are stored only on the user's machine (encrypted via the OS
  keychain through Electron's `safeStorage` when available, with an explicit
  plaintext fallback the UI discloses). Raw secrets never cross the IPC
  bridge into the renderer.
- The renderer is sandboxed (`contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`) behind a strict Content-Security-Policy and loads
  no remote content.
- The app applies a **public-read bucket policy** to the target S3 bucket so
  HLS streams play without signed URLs. This is user-controllable (the
  destination-step toggle, on by default) and disclosed in the UI — it is
  expected behavior, not a vulnerability. Please only report it if objects
  are exposed beyond the user's configured destination, or if the policy is
  applied even when the toggle is off.

Out of scope: issues requiring physical access to the user's machine,
self-XSS, and vulnerabilities in third-party dependencies without a
demonstrated exploit path through hulesa (report those upstream).
