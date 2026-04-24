# PLAN_Sprint18.md — Shared PostgreSQL platform

## Problem Statement

RCNX is developing multiple projects (VVP, singing-bridge, pistis) on the same Azure subscription. Each project currently owns or plans to own its own PostgreSQL server. `vvp-postgres` (Standard_B1ms, PG 16, UK South) is already provisioned and underused — it hosts only two databases (`vvpissuer`, `pistis`) against a 32 GB allocation. Rather than provision a second B1ms server for singing-bridge (~£12/month), the correct platform move is to promote `vvp-postgres` to a shared, governed, multi-project asset under neutral ownership.

Singing-bridge also needs a live postgres connection string before the Sprint 19 application migration can begin. This sprint delivers that endpoint.

## User Outcome

**Who benefits and what job are they doing?**
Platform engineers across all RCNX projects. Each project team needs a reliable, persistent database without owning server-level infrastructure. Today, every project that needs postgres either pays for its own server or relies on an informally shared one with no governance.

**What does success look like from the user's perspective?**
After this sprint: a singing-bridge developer can open `PLAN_Sprint19.md`, see a working `SB_DATABASE_URL` already stored in the Container App secrets, and start the application migration with no infra work remaining. VVP developers notice no change to their setup. A future third project can add a database and role to the shared server in under 30 minutes by following documented procedure.

**Why is this sprint the right next step for the product?**
Sprint 19 (app migration) cannot begin until postgres is reachable from the singing-bridge Container App. This sprint is the blocker-removal sprint.

---

## Current State

| Resource | Detail |
|----------|--------|
| `vvp-postgres` | Standard_B1ms, PG 16.11, UK South, 32 GB, public access **Disabled**, storage auto-grow **Disabled** |
| Private endpoint | `vvp-pg-pe` in `postgres-subnet` (10.0.2.0/24) of `vvp-vnet` (10.0.0.0/16) |
| Private DNS zone | `privatelink.postgres.database.azure.com` linked to `vvp-vnet` only |
| Existing databases | `vvpissuer`, `pistis` (plus system DBs) |
| Admin login | `vvpadmin` |
| `sb-env` | Consumption-only Container Apps environment — **no VNet integration**, no fixed outbound IP |
| `sb-vnet` | 10.0.0.0/16 — **overlaps** `vvp-vnet`, VNet peering blocked |

**Networking constraint:** the overlapping address spaces rule out VNet peering without re-addressing. The singing-bridge Container App has no fixed outbound IP, so the only viable path to reach a private-only postgres is a VNet-integrated environment — which requires rebuilding `sb-env`. That work is out of scope here. The practical networking solution is to enable public access on the shared server while keeping the private endpoint active for VVP.

---

## Proposed Solution

### Phase 1 — Governance: move server to shared resource group

Create `rcnx-shared-rg` in UK South. Move `vvp-postgres` there. The private endpoint, VNet link, and DNS zone all live in the `VVP` resource group; the server move is cross-group but stays within the same subscription — Azure supports this with `az resource move`. The private endpoint connection is preserved post-move.

VVP bicep must be updated to reference the new resource group for the server. No VVP application configuration changes (FQDN is unchanged).

### Phase 2 — Networking: enable public access

```bash
az postgres flexible-server update \
  --name vvp-postgres --resource-group rcnx-shared-rg \
  --public-access Enabled
```

This does **not** remove the private endpoint — both access paths coexist. VVP services continue reaching postgres via private endpoint at `10.0.2.x`, unchanged.

Add the `AllowAzureServices` firewall rule (start 0.0.0.0 / end 0.0.0.0). This permits any Azure-hosted service to attempt a connection; credentials + SSL (`sslmode=require`, enforced by Azure) are the remaining security layer. This is the same posture used by most Azure-hosted shared services.

Enable storage auto-grow so the shared server can expand without manual intervention as additional projects and data accumulate:

```bash
az postgres flexible-server update \
  --name vvp-postgres --resource-group rcnx-shared-rg \
  --storage-auto-grow Enabled
```

### Phase 3 — Per-project isolation: database and role

Each project gets its own database and a least-privilege login role. The admin never shares the `vvpadmin` credentials with application code.

```sql
-- Run as vvpadmin
CREATE DATABASE singing_bridge;
CREATE ROLE sbapp LOGIN PASSWORD '<generated-strong-password>';

-- Connect to the singing_bridge database
\c singing_bridge
GRANT CONNECT ON DATABASE singing_bridge TO sbapp;
GRANT CREATE ON SCHEMA public TO sbapp;  -- needed for sqlx migrations to create tables
```

The `sbapp` role has no access to `vvpissuer`, `pistis`, or `postgres`. PostgreSQL's grant model enforces this at the engine level.

Similarly, audit and document the VVP roles (`vvpissuer_app`, `pistis_app` or equivalent) — if they currently use `vvpadmin` directly, this sprint is the moment to create proper least-privilege roles for them too.

### Phase 4 — Credential storage

Create a shared Key Vault `rcnx-shared-kv` in `rcnx-shared-rg`. Store:

| Secret name | Value |
|-------------|-------|
| `pg-admin-password` | `vvpadmin` password (existing) |
| `sb-database-url` | `postgres://sbapp:<pw>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=require` |
| `vvp-issuer-database-url` | VVP issuer connection string (rekeyed to per-project role) |
| `pistis-database-url` | Pistis connection string (rekeyed) |

RBAC on Key Vault:
- `rcnx-shared-rg` Contributor → platform/infra role only
- `Key Vault Secrets User` on `sb-database-url` → singing-bridge managed identity (or dev team)
- `Key Vault Secrets User` on `vvp-*` secrets → VVP team

### Phase 5 — Wire singing-bridge Container App

```bash
az containerapp secret set \
  --name sb-server --resource-group sb-prod-rg \
  --secrets "sb-db-url=postgres://sbapp:<pw>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=require"

az containerapp update \
  --name sb-server --resource-group sb-prod-rg \
  --set-env-vars "SB_DATABASE_URL=secretref:sb-db-url"
```

The app still boots with `SB_DATA_DIR=/tmp` and SQLite (Sprint 19 changes the code). The env var is pre-positioned so Sprint 19 only needs a code change + redeploy — no infra work at that point.

---

## Infrastructure as Code

New files added to `infra/bicep/`:

### `infra/bicep/shared-postgres.bicep`

Idempotent template for the shared server state: public access enabled, storage auto-grow, `AllowAzureServices` firewall rule, `singing_bridge` database. Does **not** manage the server password (set out-of-band; rotated via KV).

```bicep
param serverName string = 'vvp-postgres'
param resourceGroup string = 'rcnx-shared-rg'
param dbName string = 'singing_bridge'

// Enable public access (private endpoint stays active)
resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' existing = {
  name: serverName
  scope: resourceGroup(resourceGroup)
}

resource fwAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  name: 'AllowAzureServices'
  parent: pgServer
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource sbDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  name: dbName
  parent: pgServer
}
```

### `infra/bicep/shared-keyvault.bicep`

New Key Vault in `rcnx-shared-rg` with RBAC access model (not vault access policies).

### Update: `infra/bicep/container-app.bicep`

Add `sbDatabaseUrl` secureString param and the `SB_DATABASE_URL` env var pre-positioned (pointing at secretRef). No `SB_DATA_DIR` change yet — that happens in Sprint 19.

### Update: VVP bicep (cross-project)

Change server resource group reference from `VVP` to `rcnx-shared-rg`. No other VVP changes.

---

## Test Strategy

### Property / invariant coverage

- `sbapp` can connect to `singing_bridge` database and create tables (validate with `psql` or a throwaway connection test)
- `sbapp` cannot connect to `vvpissuer` or `pistis` — verify `FATAL: permission denied for database` is returned
- `AllowAzureServices` rule is in place — verify with `az postgres flexible-server firewall-rule list`
- Private endpoint to `vvp-vnet` still resolves and connects — VVP smoke test (no VVP code change)

### Failure-path coverage

- Wrong password → connect error surfaced immediately (not silent)
- `sbapp` attempting DDL on a VVP database → rejected at PG level

### Regression guards

- VVP services (`vvp-issuer`, `pistis-backend` Container Apps) connect successfully after the resource group move — verified by checking their health endpoints post-deploy
- No VVP application configuration changes required (FQDN unchanged: `vvp-postgres.postgres.database.azure.com`)

### Fixture reuse plan

No new test fixtures — this is a pure infrastructure sprint. Validation is via `az` CLI checks and a manual `psql` connection test from a developer machine (public access now permits this).

### Test runtime budget

No automated tests added. Manual validation checklist: ~15 minutes. VVP regression: existing VVP health endpoints checked post-move.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Resource group move disrupts private endpoint | Low | Azure preserves PE connections across RG moves within same subscription; test VVP connectivity immediately after move |
| `AllowAzureServices` expands attack surface | Low-medium | Credentials + TLS are the control; strong generated password for `sbapp`; no `vvpadmin` in app code |
| VVP bicep breaks after RG move | Medium | Update VVP bicep as part of this sprint before the move; dry-run `what-if` first |
| Storage auto-grow triggers unexpected cost | Very low | B1ms tier; auto-grow adds 32 GB increments at ~£3/32 GB; budget impact negligible |
| `sbapp` role needs superuser for extensions (e.g. `citext`) | Medium | Extensions must be created by `vvpadmin` (superuser) as part of this sprint, before Sprint 19 migrations run |

### CITEXT extension — Sprint 19 dependency

Sprint 19 migrations require `CREATE EXTENSION IF NOT EXISTS citext`. This must be run by a superuser (`vvpadmin`) before `sbapp` runs migrations. Add to this sprint's checklist:

```sql
\c singing_bridge
CREATE EXTENSION IF NOT EXISTS citext;
```

---

## Files changing

| File | Change |
|------|--------|
| `infra/bicep/shared-postgres.bicep` | New: public access, firewall rule, singing_bridge database |
| `infra/bicep/shared-keyvault.bicep` | New: rcnx-shared-kv with RBAC |
| `infra/bicep/container-app.bicep` | Add `sbDatabaseUrl` param + `SB_DATABASE_URL` env var (pre-positioned for Sprint 19) |
| VVP bicep (cross-repo or same repo) | Update server RG reference: `VVP` → `rcnx-shared-rg` |

**No application code changes in this sprint.**

---

## Exit criteria

- `rcnx-shared-rg` exists; `vvp-postgres` is in it
- Public access enabled; `AllowAzureServices` firewall rule confirmed
- Storage auto-grow enabled
- `singing_bridge` database exists; `sbapp` role exists with correct grants; `citext` extension installed
- VVP services healthy after resource group move (health endpoints green)
- `SB_DATABASE_URL` secret set in singing-bridge Container App (Sprint 19 can begin immediately)
- `rcnx-shared-kv` exists with all four secrets; RBAC grants documented
- `infra/bicep/shared-postgres.bicep` committed and idempotent
