# DeployMate Phase 9 — Agile Backlog (GitHub Projects v2 + Issues)

> [!IMPORTANT]
> **Single Source of Truth:** All Epics (`DM-E1`–`DM-E6`), Sprint Milestones (`Sprint 1`–`Sprint 4`), and User Stories (`DM-901`–`DM-915`) in this document are tracked live in **GitHub Issues & Milestones** on [`nmahendran-aws/deploy-mate`](https://github.com/nmahendran-aws/deploy-mate/issues). Merging a PR with `Closes #<issue_number>` automatically closes the Story and updates the parent Epic's completion bar.

---

## 1. Phase 9 Scope & 4-Sprint Plan

### Objective
Transform DeployMate from its Phase 8 AWS MVP into a **multi-tenant, commercial AWS SaaS + BYOC platform** ready to onboard its first paying Student Pro (\$7), Builder (\$19), and Growth (\$99) customers.

| In-Scope for Phase 9 (8 Weeks / 4 Sprints) | Out-of-Scope (Deferred to Phase 10–13) |
| :--- | :--- |
| Cloud-agnostic refactoring of [`deployment.ts`](../backend/src/types/deployment.ts) & [`baseDeployer.ts`](../backend/src/deployers/baseDeployer.ts) | Live Google Cloud (`Cloud Run` / `Cloud Storage`) deployers *(Phase 10)* |
| PostgreSQL multi-tenant data store + BullMQ/Redis async worker queue | Live Microsoft Azure (`Container Apps` / `Front Door`) deployers *(Phase 11)* |
| Auth (GitHub/Google OAuth + `.edu` detection), Orgs, Projects & RBAC | Provisioning managed RDS / Cloud SQL / Redis clusters *(Phase 10)* |
| Official GitHub App: private repos, `git push` CI/CD, & **PR Preview Live URLs** | Multi-service `docker-compose.yml` visual canvas & Terraform HCL export *(Phase 11)* |
| **AWS Cross-Account BYOC** (`sts:AssumeRole` 1-click CloudFormation onboarding) | Autonomous AI PR-opening DevOps Copilot & Canary sliders *(Phase 12)* |
| **Nixpacks** universal builder (Go, Python, Rust, Java, Ruby, PHP) + **OpenNext** SSR | Multi-cloud active-active DNS failover & SOC 2 / HIPAA packs *(Phase 13)* |
| Instant `*.deploymate.app` wildcard edge routing, AES-256 Env Vault, & **Stripe** 4-tier billing | AWS / GCP / Azure Cloud Marketplace enterprise listings *(Phase 13)* |

### Global Definition of Done (DoD)
- [ ] Strict TypeScript compilation passes (`npm run build` across `backend` and `frontend`).
- [ ] Unit, integration, and security tests added to [`runTests.ts`](../backend/src/__tests__/runTests.ts) with >= 85% coverage on touched modules.
- [ ] Verified in both `AWS_DRY_RUN=true` simulation mode and live credential mode.
- [ ] Tenant isolation verified: Organization A cannot read, mutate, or delete Organization B's deployments or secrets.

---

## 2. Epic & User Story Index (96 Total Story Points)

| Ticket | GitHub Issue | Type | Title | Points | Priority | Sprint |
| :--- | :---: | :--- | :--- | :---: | :---: | :--- |
| **`DM-E1`** | [#16](https://github.com/nmahendran-aws/deploy-mate/issues/16) | **Epic** | Cloud-Agnostic Core Refactor & Multi-Tenant Persistence + Job Queue | *21* | `P0` | Sprint 1 |
| `DM-901` | [#1](https://github.com/nmahendran-aws/deploy-mate/issues/1) | Story | Refactor Deployment Types & Deployer Registry to Cloud-Agnostic Interfaces | 5 | `P0` | Sprint 1 |
| `DM-902` | [#2](https://github.com/nmahendran-aws/deploy-mate/issues/2) | Story | Migrate Local JSON Store to Multi-Tenant PostgreSQL Repository Layer | 8 | `P0` | Sprint 1 |
| `DM-903` | [#3](https://github.com/nmahendran-aws/deploy-mate/issues/3) | Story | Extract In-Process Build Pipeline into Durable Asynchronous Worker Queue | 8 | `P0` | Sprint 1 |
| **`DM-E2`** | [#17](https://github.com/nmahendran-aws/deploy-mate/issues/17) | **Epic** | Identity, Multi-Tenant Workspaces & Role-Based Access Control (RBAC) | *10* | `P0` | Sprint 1 |
| `DM-904` | [#4](https://github.com/nmahendran-aws/deploy-mate/issues/4) | Story | Implement GitHub/Google OAuth, Session Auth Middleware & `.edu` Detection | 5 | `P0` | Sprint 1 |
| `DM-905` | [#5](https://github.com/nmahendran-aws/deploy-mate/issues/5) | Story | Build Multi-Tenant Organizations, Projects (`prod`/`preview`) & RBAC Permissions | 5 | `P1` | Sprint 1 |
| **`DM-E3`** | [#18](https://github.com/nmahendran-aws/deploy-mate/issues/18) | **Epic** | Official GitHub App Integration, CI/CD Auto-Deploy & Ephemeral PR Previews | *21* | `P0` | Sprint 2 |
| `DM-906` | [#6](https://github.com/nmahendran-aws/deploy-mate/issues/6) | Story | Support Private GitHub Repositories via GitHub App Installation Tokens | 5 | `P0` | Sprint 2 |
| `DM-907` | [#7](https://github.com/nmahendran-aws/deploy-mate/issues/7) | Story | Implement HMAC GitHub Push Webhooks, Commit Checks & 1-Click Rollback | 8 | `P0` | Sprint 2 |
| `DM-908` | [#8](https://github.com/nmahendran-aws/deploy-mate/issues/8) | Story | Auto-Deploy Ephemeral PR Preview Live URLs & Auto-Destroy on Merge/Close | 8 | `P1` | Sprint 2 |
| **`DM-E4`** | [#19](https://github.com/nmahendran-aws/deploy-mate/issues/19) | **Epic** | AWS BYOC Cross-Account Onboarding & Universal "Any App" Builder | *21* | `P0` | Sprint 3 |
| `DM-909` | [#9](https://github.com/nmahendran-aws/deploy-mate/issues/9) | Story | 1-Click CloudFormation BYOC Onboarding & Per-Tenant STS Credential Provider | 8 | `P0` | Sprint 3 |
| `DM-910` | [#10](https://github.com/nmahendran-aws/deploy-mate/issues/10) | Story | Integrate Nixpacks Auto-Containerization for Go, Rust, Python, Java, Ruby & PHP | 8 | `P1` | Sprint 3 |
| `DM-911` | [#11](https://github.com/nmahendran-aws/deploy-mate/issues/11) | Story | Add OpenNext Serverless SSR Adapter for Next.js 14/15 App Router | 5 | `P2` | Sprint 3 |
| **`DM-E5`** | [#20](https://github.com/nmahendran-aws/deploy-mate/issues/20) | **Epic** | Global Instant Live URL Edge, Encrypted Secrets Vault & Viral Loop | *10* | `P0` | Sprint 2 & 4 |
| `DM-912` | [#12](https://github.com/nmahendran-aws/deploy-mate/issues/12) | Story | Instant Wildcard HTTPS Routing (`*.deploymate.app`) & Free-Tier Viral Corner Pill | 5 | `P1` | Sprint 4 |
| `DM-913` | [#13](https://github.com/nmahendran-aws/deploy-mate/issues/13) | Story | Implement AES-256-GCM Encrypted Secrets Store Scoped by Environment | 5 | `P0` | Sprint 2 |
| **`DM-E6`** | [#21](https://github.com/nmahendran-aws/deploy-mate/issues/21) | **Epic** | 4-Tier Monetization Engine, Stripe Billing & Quota Guardrails | *13* | `P0` | Sprint 4 |
| `DM-914` | [#14](https://github.com/nmahendran-aws/deploy-mate/issues/14) | Story | Integrate Stripe Checkout, Customer Portal & Webhook Lifecycle Sync | 8 | `P0` | Sprint 4 |
| `DM-915` | [#15](https://github.com/nmahendran-aws/deploy-mate/issues/15) | Story | Upgrade `SecurityGuardrails` to Enforce Per-Plan Quotas & Sandbox Auto-Sleep/TTL | 5 | `P0` | Sprint 4 |
