# Third-party notices

This repository is a fork of
[`aloth/olcli`](https://github.com/aloth/olcli), distributed under the MIT
License. The original copyright notice is retained in [LICENSE](LICENSE).

## Runtime dependencies

The package directly depends on the following third-party projects. Their
package metadata and included license files are authoritative.

| Package | Declared license |
|---------|------------------|
| `@modelcontextprotocol/sdk` | MIT |
| `adm-zip` | MIT |
| `chalk` | MIT |
| `cheerio` | MIT |
| `commander` | MIT |
| `conf` | MIT |
| `ignore` | MIT |
| `ora` | MIT |
| `tough-cookie` | BSD-3-Clause |
| `zod` | MIT |

Transitive dependencies and exact resolved versions are recorded in
`package-lock.json`.

## Protocol references

The implementation was informed by observable Overleaf behavior and the
publicly available Overleaf source repository, which is licensed AGPLv3. No
Overleaf source file is copied into this MIT repository. Links in the protocol
documentation identify the behavioral/schema references used.

The community `overleaf-cli`, `pyoverleaf`, `overleaf.nvim`, and related tools
were reviewed as interoperability references. Their code is not vendored or
redistributed here.

Sanitized JSON fixtures record protocol shapes captured from a dedicated
disposable project. They contain synthetic identifiers and text, not copied
application source or production manuscript data.
