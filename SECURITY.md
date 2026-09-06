# Security Policy

Only the latest release is supported. Fixes ship in a new version.

**Please report security issues privately**, not in a public issue. Two ways:

- [Report a vulnerability](https://github.com/aloth/olcli/security/advisories/new) on GitHub
- Email home@alexloth.com

Include the olcli version, whether the Overleaf instance is overleaf.com or
self-hosted, and how to reproduce it.

This is a side project, so I cannot promise a response time, but I read every
report.

olcli stores Overleaf credentials on disk. That is intentional: `conf` writes
plain JSON, and `olcli check` prints the path. Since 0.12.0 the account
password is not stored unless you pass `--save-password`. Credentials showing
up somewhere *else* - in output, logs, or outside your home directory - is a
bug worth reporting.
