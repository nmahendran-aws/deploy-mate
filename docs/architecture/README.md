# DeployMate Architecture & Engineering Documentation

Welcome to the comprehensive technical documentation for DeployMate. This directory details the core subsystems, security guardrails, multi-cloud registry, and deployment engines powering DeployMate.

---

## Architecture Index

| Document | Feature Code / Issue | Summary |
| :--- | :--- | :--- |
| **[1. Multi-Cloud Deployer Registry](01_MULTI_CLOUD_REGISTRY.md)** | `DM-901` (#1) | Two-dimensional deployer matrix mapping workloads (`STATIC_EDGE`, `CONTAINER_SERVICE`, `SERVERLESS_FUNC`, `SSR_WEB`) to cloud primitives across **AWS**, **GCP**, and **Azure**. |
| **[2. Bounded Worker Queue & Execution Isolation](02_BOUNDED_WORKER_QUEUE.md)** | `DM-903` (#3) | Concurrency-capped FIFO worker pool (`maxConcurrency = 5`), timeout watchdog timer (10 min), and Server-Sent Events (SSE) log streaming. |
| **[3. Multi-Tenant Auth, Workspaces & RBAC](03_MULTITENANT_AUTH_AND_RBAC.md)** | `DM-904`, `DM-905` (#4, #5) | Stateless JWT sessions, automatic Personal Workspace provisioning, `.edu` student verification, four-tier RBAC (`OWNER`, `ADMIN`, `DEVELOPER`, `VIEWER`), and anti-IDOR protection. |
| **[4. GitHub App Integration & Zero-Exfiltration Isolation](04_GITHUB_APP_INTEGRATION.md)** | `DM-906` (#6) | RS256 GitHub App token exchange, AES-256-GCM vaulted local tokens, repository/branch discovery, and `.git/config` credential scrubbing. |
| **[5. Webhooks, CI/CD, PR Previews & Instant Rollback](05_WEBHOOKS_AND_INSTANT_ROLLBACK.md)** | `DM-907`, `DM-908` (#7, #8) | HMAC-SHA256 constant-time verification, replay deduplication, ephemeral PR preview deploys with single upserted bot comments, and <10ms instant production rollback. |
| **[6. AES-256-GCM Encrypted Secrets Vault](06_SECRETS_VAULT_AND_ENCRYPTION.md)** | `DM-913` (#13) | Authenticated GCM encryption with AAD context binding, multi-line `.env` parser, in-memory decryption, and automated `[REDACTED]` log scrubbing. |
| **[7. Cloud Provisioning & Teardown Lifecycle](07_INFRASTRUCTURE_PROVISIONING_AND_TEARDOWN.md)** | Core Cloud Architecture | In-app dynamic infrastructure provisioning across targets, tracked resource state maps, 1-click clean teardown, and dry-run vs. live AWS execution. |

---

## Cross-Cutting Security Principles

1. **Zero Credential Exfiltration**: Build sandboxes strip host AWS and GitHub tokens before invoking untrusted user build commands (`npm run build`).
2. **Never Store Plaintext Secrets**: All user environment variables and GitHub access tokens are encrypted with AES-256-GCM before writing to the database.
3. **Atomic Subdomain Allocation**: Subdomain collisions (`HTTP 409 Conflict`) and unsupported cloud targets (`HTTP 501 Coming Soon`) fail before any DNS reservation occurs.
4. **Immutable Rollback Pointers**: Instant rollback avoids rebuilds by switching CDN origins to verified historical deployment artifacts in `<10ms`.
