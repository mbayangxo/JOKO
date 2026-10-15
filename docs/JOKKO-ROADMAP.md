# Jokko roadmap: actual state of the repository

**Branch:** `claude/jokko-forensic-audit-rprqia`. The final commit is in `docs/JOKKO-J15-HANDOFF.md`.

Every milestone below is a **local engineering milestone**: code, tests and fresh-database gates on this branch. **Nothing on this branch is deployed.** Production runs `b0318b5` (`7d262de` + the P0-A containment, runtime verification incomplete) with open incidents (see the handoff, §8).

Product scope and the year plan stay in `docs/K21-BUILD-SPEC.md`. This file tracks engineering milestones.

## Completed milestones

| Milestone | Scope | Report | State |
|---|---|---|---|
| J1 | Forensic audit, financial-safety fixes, P2P undo, tontine consent | `JOKKO-FORENSIC-EVIDENCE-REPORT.md`, `JOKKO-PRODUCT-GAPS.md` | Done (local) |
| J2 | Money kernel: double-entry ledger, kernel recipes, provider adapter, external-operation state machine, reconciliation, migrations, torture suite | `JOKKO-J2-DESIGN.md`, `JOKKO-J2-GATE-REPORT.md` | Gate met (local) |
| J3 | Identity, sessions, devices, recovery, KYC tiers, business staff, admin separation of duties, risk engine, central route policy | `JOKKO-J3-DESIGN.md`, `JOKKO-J3-GATE-REPORT.md`, `JOKKO-J3-PERMISSION-MATRIX.md` | Gate met (local) |
| J4 | Money vertical slices: home, history, receipts, cash-in/out, P2P, requests, merchant QR, refunds, intents | `JOKKO-J4-REPORT.md` | Gate met (local) |
| J5 | Merchant and business OS: roles, wallet, catalog, orders, payroll boundary, economic architecture | `JOKKO-J5-REPORT.md`, `JOKKO-ECONOMIC-OS-ARCHITECTURE.md` | Gate met (local) |
| J6 | Agents and cash network: float, cash-in/out handoff, commissions, reconciliation, Kabu mapped settlement | `JOKKO-J6-REPORT.md` | Gate met (local) |
| J7 | Commerce and distribution: business suspension gate, distributor OS, purchase orders, invoices, credit, restock | `JOKKO-J7-REPORT.md`, `JOKKO-J7-COMMERCE.md` | Gate met (local) |
| J8 | Logistics: shipments, couriers, proofs, fees, COD, pickup points, returns, disputes, UI | `JOKKO-J8-REPORT.md`, `JOKKO-J8-LOGISTICS.md` | Internal-pilot gate met (local); money dormant |
| J9 | Work and opportunity: assignments, escrow, earnings, settlement policy, coop payout fix | `JOKKO-J9-REPORT.md`, `JOKKO-J9-WORK.md` | Internal-pilot ready (local); J9 money OFF |
| J10 | Community and daily life: notifications, home, groups, moderation, discovery | `JOKKO-J10-REPORT.md` | Done (local) |
| J11 | Collective money: tontine engine, goal savings, protected funds, coop capital records | `JOKKO-J11-REPORT.md`, `JOKKO-J11-SETTLEMENT-POLICY.md` | Done (local); engine dormant |
| J12 | Offline, low bandwidth, localization, PIN / idempotency proofs | `JOKKO-J12-REPORT.md` | Done (local) |
| J13 | UX audit, financial-state clarity, recipient identity binding, F17 uncertain-payment states | `JOKKO-J13-REPORT.md`, `JOKKO-J13-F17-REPORT.md`, `JOKKO-J13-RECIPIENT-BINDING.md` | Done (local) |
| J14 | Ecosystem integration: signed partner events, scoped partner keys, product mapping, fulfilment, chat orders, S4 partner debits, audit retention | `JOKKO-J14-REPORT.md`, `JOKKO-J14-FOLLOWUP-REPORT.md`, `JOKO-PARTNER-API.md` | Done (local); every capability behind an off flag |
| J15 | Financial torture lab (L0–L7), S4 approval screen, shared partner rate limits, P0 reproductions, J4 / OI-1 root causes, security review | `JOKKO-J15-REPORT.md`, `JOKKO-J15-LAB.md` | See the J15 report verdict |

## Open production track (separate, never bundled)

Packages exist under `docs/incidents/`.

- P0-A: tontine drain. Containment deployed as `b0318b5`; runtime verification incomplete.
- P0-B: delivery-dispute ruling.
- F1: coop double payout.
- F4: affiliate commission (latent).
- Web slow boot.

P0-B, F1 and the web slow boot are open on `b0318b5`. Each needs an authorized, separate deploy and production verification; none is done.

## Next: J16 (recommended)

See `docs/JOKKO-J15-HANDOFF.md`, §11.
