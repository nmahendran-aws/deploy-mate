Here is your complete, hackathon-ready submission writeup formatted for Devpost and judge review:

---

## Inspiration

Developers love the magic of **Vercel** and **Netlify**—push to git and your site is live with a custom domain and SSL certificate. But as soon as applications grow, teams hit a brutal wall:
1. **The Cloud Mark-Up & Seat Tax:** Massive bandwidth markups (\$40–\$55 per 100 GB) and \$20/month per-developer seat fees for what is fundamentally just edge caching.
2. **The Container Ceiling:** You cannot run long-lived Docker containers, WebSockets, or stateful Python/Node microservices without hitting hard 10-to-60-second execution timeouts.
3. **Black-Box Vendor Lock-In:** Your cloud resources exist inside *their* walled garden rather than your own infrastructure.

On the other hand, setting up raw **AWS** with best practices takes hours of tedious plumbing: S3 bucket policies, CloudFront Origin Access Control (OAC), ACM SSL certificates in `us-east-1`, Route 53 DNS records, ECR repositories, ECS Fargate tasks, and ALB target groups. 

We asked ourselves: ***Why can't developers get Vercel's 1-click simplicity directly on 100% native AWS infrastructure inside their own account?*** That inspiration led us to build **DeployMate**.

---

## What it does

**DeployMate** is an autonomous, multi-target cloud deployment platform that turns any public GitHub repository into production-ready AWS infrastructure in under 60 seconds:

- **Automated Stack Inspection & Recommendation:** Evaluates `package.json`, `Dockerfile`, `serverless.yml`, or framework signatures, calculating confidence scores across 4 native AWS deployment targets.
- **4 Native AWS Deployment Architectures:**
  1. **S3 + CloudFront (OAC):** For static SPAs (React, Vite, Vue, Astro) with private S3 buckets and global SigV4 edge caching.
  2. **Amazon ECR + ECS Fargate + ALB:** For Dockerized microservices, FastAPI, and Express backends with automatic non-root `Dockerfile` generation and zero cold starts.
  3. **AWS Lambda + HTTP API Gateway v2:** For lightweight serverless handlers packaged via an in-memory CRC-32 PKZIP bundler.
  4. **AWS Amplify Hosting (`WEB_COMPUTE`):** For Next.js App Router SSR and full-stack workloads.
- **Custom Route 53 Subdomains & Wildcard ACM TLS:** Features atomic RFC-1123 hostname reservations and live Route 53 `A`/`AAAA` alias provisioning on `maas-fam.com` with wildcard ACM TLS certificates in `us-east-1`.
- **Zero-Trust Security Sandbox:** Strips `AWS_*` and `GITHUB_*` credentials from build processes to prevent supply-chain exfiltration, blocks shell metacharacters, and enforces symlink boundary containment.
- **Phase 8 Self-Healing Engine:** Diagnoses build failures (missing lockfiles, empty output directories, port mismatches) and autonomously remediates them on the fly.
- **1-Click Total AWS Teardown:** Completely cleans up cloud infrastructure and releases reserved DNS records with a single click.

---

## How we built it

DeployMate was engineered from the ground up as an enterprise-grade cloud control plane:

- **Frontend Dashboard:** Built with **Next.js 14**, **React**, and **Tailwind CSS**, featuring dynamic theme switching (**Obsidian Velvet**, **Midnight Amber**, **Emerald Matrix**), real-time telemetry streams, an interactive 5-stage AWS topology visualizer, and a live Cloud Cost ROI calculator comparing AWS vs. Vercel/Netlify.
- **Backend Orchestrator:** Developed with **Node.js**, **Express**, and **TypeScript**, modularized into clean deployer engines:
  - `s3Deployer.ts`: Provisions private S3 buckets and CloudFront distributions with Origin Access Control.
  - `ecsFargateDeployer.ts`: Automates ECR repos, Task Definitions, Fargate Services, and ALB Target Groups.
  - `lambdaApiGatewayDeployer.ts`: Handles IAM roles, Lambda functions, and HTTP API v2 integration.
  - `amplifyDeployer.ts`: Automates `amplify.yml` generation and `WEB_COMPUTE` SSR deployment.
  - `domainManager.ts`: Manages atomic subdomain reservations and Route 53 alias records.
  - `isolatedBuilder.ts` & `securityGuardrails.ts`: Sandboxes builds, strips sensitive environment variables, and enforces symlink path safety.
  - `selfHealingEngine.ts`: Automated diagnosis, pattern-matching remediation, and deployment retry loop.
- **AWS Cloud SDK:** Directly integrates with `@aws-sdk/client-s3`, `@aws-sdk/client-cloudfront`, `@aws-sdk/client-route-53`, `@aws-sdk/client-acm`, `@aws-sdk/client-ecs`, `@aws-sdk/client-ecr`, `@aws-sdk/client-lambda`, and `@aws-sdk/client-apigatewayv2`.

---

## Challenges we ran into

1. **CloudFront OAC with SigV4 Permissions:** Ensuring private S3 buckets reject all public ACLs while granting seamless read access exclusively to CloudFront required fine-tuning S3 Bucket Policies with strict `AWS:SourceArn` distribution conditions.
2. **Cross-Region ACM Certificate Constraints:** CloudFront requires SSL certificates to exist strictly in `us-east-1`. We architected the domain manager to dynamically validate and bind pre-warmed wildcard certificates (`*.maas-fam.com`) across both global CloudFront distributions and regional ALBs.
3. **Build Security & Symlink Escapes:** Running builds on untrusted repositories posed supply-chain risks. We implemented `verifyWorkspaceSafety` using `fs.realpathSync` and `fs.lstatSync` to catch directory traversal attacks and malicious symlinks attempting to escape into system directories.
4. **Race Conditions in Cloud Resource Verification:** Gating the live URL until DNS and TLS handshakes were fully active required building a robust polling pipeline with exponential backoff to avoid returning prematurely broken HTTPS links.

---

## Accomplishments that we're proud of

- **True Multi-Target Autonomous Routing:** DeployMate doesn't just deploy static sites—it automatically distinguishes between a static SPA, a Dockerized backend, a serverless API, and a Next.js SSR app, provisioning the exact right cloud primitives for each.
- **80%+ Cloud Cost Reduction:** Built a live cost calculator proving that engineering teams save thousands per year by bypassing PaaS seat taxes and bandwidth surcharges in favor of raw AWS rates.
- **Self-Healing Build Resilience:** Designed an autonomous remediation engine that catches empty build directories and build errors, applies fixes, and completes deployments without developer intervention.
- **Zero Ghost Infrastructure:** 1-click teardown actually deletes S3 buckets, disables and removes CloudFront distributions, cleans up route records, and releases reservations instantly.

---

## What we learned

- **AWS Cloud Architecture at Scale:** Deepened our expertise in the intricacies of CloudFront OAC, ECS Fargate networking, ALB health check life cycles, and Route 53 alias routing.
- **Defense-in-Depth for Build Systems:** Learned how vulnerable standard CI/CD pipelines are to environment variable exfiltration via `postinstall` hooks, and how essential strict environment sanitization is.
- **Designing for Developer Experience:** Realized that developer happiness doesn't require sacrificing cloud ownership—great DX can be built directly on top of native cloud primitives.

---

## What's next for DeployMate

- **GitHub App & PR Preview Environments:** Automatically spinning up isolated ephemeral AWS preview stacks for every pull request, and tearing them down when merged.
- **Multi-Cloud Target Support:** Expanding the recommendation engine beyond AWS to support Google Cloud Run and Azure Container Apps using the same unified DX.
- **Database & Persistent Volume Attachment:** 1-click provisioning of Amazon RDS (PostgreSQL/MySQL) and DynamoDB instances automatically wired into container and Lambda environments.
- **SOC 2 & Terraform Export:** Giving developers the ability to click "Export Terraform" to generate clean, readable HCL code for all infrastructure provisioned by DeployMate.