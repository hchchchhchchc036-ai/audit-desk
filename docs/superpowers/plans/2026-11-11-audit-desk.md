# Audit Desk Implementation Plan

> For agentic workers: use subagent-driven-development for independent implementation tasks, with spec and code review before acceptance.

**Goal:** Deliver a runnable Windows desktop app for importing projects, model-driven audits, isolated tests, extensible installed Skills and evidence reports.

**Architecture:** Electron local renderer calls a restricted IPC bridge. TypeScript backend owns project indexing, encrypted configuration, Skills, task runners, OCR installation and shared model configuration.

**Tech Stack:** Electron, TypeScript, Node.js built-ins, Mermaid, ignore, Docker for untrusted execution, Playwright for UI verification.

## 1. Project and Skill substrate

Files: src/project.ts, src/skills.ts, tests/project-skills.test.cjs, scripts/install-skills.py.

- [ ] Write Node assertions for scope traversal rejection, secret/ignore exclusions and Skill import validation; run `node --test tests/project-skills.test.cjs` and observe missing implementation.
- [ ] Implement `indexProject(root)` and `selectFiles(snapshot, scopes)` using contracts.ts, refuse links and enforce input budgets.
- [ ] Implement SkillRegistry with local/GitHub import, immutable source copies, metadata, enabled state and bounded downloads. Download selected licensed upstream Skills and copy required local security-audit/OCR guidance.
- [ ] Re-run module tests; record real installation versions in skills/manifest.json.

## 2. Audit and test execution

Files: src/engine.ts, src/reports.ts, tests/engine.test.cjs.

- [ ] Write tests using local stub model and non-executable fixtures for scoped coverage, cancellation, output validation and HTML escaping. Run tests before implementation.
- [ ] Implement TaskEngine start/list/get/cancel, partial results, per-run logs, report persistence. Model auditing separates discovery and verification and never claims unsupported independent workflow completion.
- [ ] Implement OCR scan using app-managed runner, bounded Docker unit/function/automation/performance execution, generated test plans and honest blocked states for unavailable dependencies.
- [ ] Generate HTML/Markdown/JSON reports and Mermaid diagrams; run engine regression tests.

## 3. Desktop UI

Files: src/ui/index.html, src/ui/app.js, src/ui/styles.css.

- [ ] Build Chinese local UI with five navigation destinations, native folder import, dashboard, scope and Skill selection, task progress/cancel, findings, report export, models and tools.
- [ ] All backend access uses window.audit.invoke(action,payload), all dynamic text uses textContent. Confirm outgoing model code range before starting user-selected work.
- [ ] UI accesses capabilities/state before claiming availability. No fake report or populated demonstration task on first launch.
- [ ] Verify real Electron window with Playwright and save screenshot.

## 4. Integration, verification and packaging

Files: src/main.ts, src/preload.ts, src/model.ts, src/ocr.ts, src/store.ts, scripts/*.cjs, README.md, docs/SELF-TEST.md.

- [ ] Add tests for model HTTP behavior, encrypted storage and OCR argument/environment mapping; observe failure first.
- [ ] Implement validated IPC, sender checks, native dialogs, encryption, model protocols and a single model configuration shared with OCR; support automatic detection/installation when OCR is missing.
- [ ] `npm.cmd install`; `npm.cmd test`; `npm.cmd run test:ui`; inspect generated screenshot and run app smoke workflow.
- [ ] `npm.cmd run dist`; document tested paths and any external model/container dependency blockers with exact causes. Provide launcher and installation artifact.

No paid model call without configured user credentials. Installed Skill scripts are data until selected and executed by a restricted runner. Do not alter original project files.
