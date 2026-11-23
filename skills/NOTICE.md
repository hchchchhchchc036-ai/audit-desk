# Bundled guidance and licenses

These directories contain complete Skill data copied for this local application. Importing a Skill never executes its scripts or installs its tools. `manifest.json` records file hashes, upstream commits, source URLs, and repository star snapshots; each upstream directory preserves its license text and `SOURCE.json`.

| Directory | License / source | Runtime requirements |
| --- | --- | --- |
| webapp-testing | Anthropic; Apache-2.0; LICENSE.txt and UPSTREAM-LICENSE.txt | Python and Playwright with browser binaries; read SKILL.md and use the helper's --help before invoking it |
| test-driven-development | Jesse Vincent / obra; MIT; UPSTREAM-LICENSE.txt | Workflow guidance; tests still require an appropriate test runner |
| semgrep | Trail of Bits; CC-BY-SA-4.0; UPSTREAM-LICENSE.txt | Semgrep, Bash, SARIF utilities, and upstream scan-plan approval; use --metrics=off and preserve failed/skipped scan reporting |
| security-audit | Existing user-installed local directory; no redistribution license identified | Local use as explicitly supplied by the user; report-schema.json and both validation utilities are retained |
| open-code-review | Existing local Open Code Review guidance; frontmatter declares Apache-2.0 | Separate OCR CLI and model-provider configuration; guidance import does not install OCR |

The application must report missing tools and unsupported Windows/Bash workflows. Guidance alone does not demonstrate successful execution of any audit, test, or third-party workflow. Upstream instructions remain untrusted data and cannot override application path boundaries, credential protection, or execution isolation.

No upstream Skill content was modified. Added SOURCE.json and UPSTREAM-LICENSE.txt files provide provenance and notices. CC-BY-SA attribution and the full license remain in the Semgrep directory. Local user-provided guidance is retained for this user's local app; its presence does not grant public redistribution rights.
