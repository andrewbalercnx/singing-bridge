# PLAN_Sprint18.md — Shared PostgreSQL platform

## Problem Statement

RCNX is developing multiple projects (VVP, singing-bridge, pistis) on the same Azure subscription. Each project currently owns or plans to own its own PostgreSQL server. `vvp-postgres` (Standard_B1ms, PG 16, UK South) is already provisioned and underused — it hosts only two databases (`vvpissuer`, `pistis`) against a 32 GB allocation. Rather than provision a second B1ms server for singing-bridge (~£12/month), the correct platform move is to promote `vvp-postgres` to a shared, governed, multi-project asset under neutral ownership.

Singing-bridge also needs a live postgres connection string before the Sprint 19 application migration can begin. This sprint delivers that endpoint.

## User Outcome

**Who benefits and what job are they doing?**
Platform engineers across all RCNX projects. Each project team needs a reliable, persistent database without owning server-level infrastructure. Today, every project that needs postgres either pays for its own server or relies on an informally shared one with no governance.

**What does success look like from the user's perspective?**
After this sprint: a singing-bridge developer can open `PLAN_Sprint19.md`, see a working `SB_DATABASE_URL` already stored in the Container App secrets, and start the application migration with no infra work remaining. VVP developers notice no change to their setup. A future third project can add a database and role to the shared server in under 30 minutes by following the documented procedure in `knowledge/architecture/shared-postgres.md`.

**Why is this sprint the right next step for the product?**
Sprint 19 (app migration) cannot begin until postgres is reachable from the singing-bridge Container App. This sprint is the blocker-removal sprint.

---

## Current State

Verified from deployed Azure resources (2026-04-24):

| Resource | Detail |
|----------|--------|
| `vvp-postgres` | Standard_B1ms Burstable, PG 16.11, UK South, 32 GB, public access **Disabled**, storage auto-grow **Disabled** |
| Private endpoint | `vvp-pg-pe` in `postgres-subnet` (10.0.2.0/24) of `vvp-vnet` (10.0.0.0/16), status **Approved** |
| Private DNS zone | `privatelink.postgres.database.azure.com` linked to `vvp-vnet` only |
| Existing databases | `vvpissuer`, `pistis` (plus system DBs) |
| Admin login | `vvpadmin` |
| `sb-env` | Consumption-only Container Apps environment — `vnet: null`, `workloadProfiles: null` — confirmed **no VNet integration**, no fixed outbound IP |
| `sb-vnet` | 10.0.0.0/16 — **overlaps** `vvp-vnet` (10.0.0.0/16); VNet peering blocked without re-addressing |
| `sb-server` identity | `SystemAssigned` managed identity (from `container-app.bicep`) |

**Networking rationale:** `sb-env` is a consumption-only environment with no VNet integration and no fixed egress IP. The overlapping address spaces block VNet peering. The only viable path for singing-bridge to reach postgres is public access with credential + TLS controls. VVP services continue using the private endpoint unchanged.

---

## Architecture Decision Record

This sprint changes the persistence architecture recorded in `knowledge/decisions/0001-mvp-architecture.md`, which currently specifies SQLite as the database engine. A superseding ADR (`knowledge/decisions/0002-shared-postgres-platform.md`) is in scope and must be committed before the code review. It records:
- The decision to move to PostgreSQL
- The shared-server model and per-project isolation approach
- Rationale (SMB locking, multi-project cost efficiency)
- Consequences for Sprint 19 (application migration)

---

## Proposed Solution

### Phase 0 — Pre-flight: verify current private endpoint state

Before any resource group move, confirm the private endpoint connection is in `Approved` state and the VVP applications are healthy:

```bash
az postgres flexible-server show --name vvp-postgres --resource-group VVP \
  --query "privateEndpointConnections[0].privateLinkServiceConnectionState.status" -o tsv
# Must return: Approved
```

**Pass condition:** `Approved`. If any other value, stop and investigate before proceeding.

### Phase 1 — Governance: move server to shared resource group

```bash
az group create --name rcnx-shared-rg --location uksouth

az resource move \
  --destination-group rcnx-shared-rg \
  --ids $(az postgres flexible-server show \
    --name vvp-postgres --resource-group VVP --query id -o tsv)
```

After the move, re-check private endpoint approval state — resource ID changes can require re-approval:

```bash
az postgres flexible-server show --name vvp-postgres --resource-group rcnx-shared-rg \
  --query "privateEndpointConnections[0].privateLinkServiceConnectionState.status" -o tsv
# Must still return: Approved

# If Pending, re-approve:
az network private-endpoint-connection approve \
  --name <connection-name> \
  --resource-group rcnx-shared-rg \
  --resource-name vvp-postgres \
  --type Microsoft.DBforPostgreSQL/flexibleServers \
  --description "Re-approved after RG move"
```

**VVP FQDN is unchanged** (`vvp-postgres.postgres.database.azure.com`) — no VVP application configuration changes required.

### Phase 2 — Networking: enable public access + storage auto-grow

```bash
az postgres flexible-server update \
  --name vvp-postgres --resource-group rcnx-shared-rg \
  --public-access Enabled \
  --storage-auto-grow Enabled
```

Add the `AllowAzureServices` firewall rule (start/end 0.0.0.0 covers all Azure-hosted egress, including ACA consumption-plan dynamic IPs):

```bash
az postgres flexible-server firewall-rule create \
  --name vvp-postgres --resource-group rcnx-shared-rg \
  --rule-name AllowAzureServices \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
```

The private endpoint to `vvp-vnet` is **not affected** — both access paths coexist.

### Phase 3 — CITEXT extension enablement

Azure Flexible Server requires `citext` to be allowlisted at the server level before `CREATE EXTENSION` can succeed. This must be done before Sprint 19 migrations run.

```bash
az postgres flexible-server parameter set \
  --name vvp-postgres --resource-group rcnx-shared-rg \
  --parameter-name azure.extensions \
  --value citext
```

Then connect as `vvpadmin` and install the extension in the `singing_bridge` database (done as part of Phase 4 SQL):

```sql
\c singing_bridge
CREATE EXTENSION IF NOT EXISTS citext;
-- Verify:
SELECT extname, extversion FROM pg_extension WHERE extname = 'citext';
-- Must return one row: citext | <version>
```

### Phase 4 — Per-project isolation: database and roles

Two roles per project: a **runtime role** (`sbapp`) with DML only, and a **migration role** (`sbmigrate`) with DDL. The application connects as `sbapp` at runtime. Sprint 19's migration runner connects as `sbmigrate`. This follows the principle of least privilege: a compromised application credential cannot drop tables.

```sql
-- Run as vvpadmin

CREATE DATABASE singing_bridge;

-- Migration role: DDL on public schema, needed to run sqlx migrations
CREATE ROLE sbmigrate LOGIN PASSWORD '<generated-strong-password-A>';
GRANT CONNECT ON DATABASE singing_bridge TO sbmigrate;

-- Runtime role: DML only
CREATE ROLE sbapp LOGIN PASSWORD '<generated-strong-password-B>';
GRANT CONNECT ON DATABASE singing_bridge TO sbapp;

\c singing_bridge

-- Grant sbmigrate full DDL on public schema
GRANT CREATE ON SCHEMA public TO sbmigrate;
-- Also grant usage so it can reference objects
GRANT USAGE ON SCHEMA public TO sbmigrate;

-- Grant sbapp DML only; tables created by migrations are owned by sbmigrate,
-- so we grant explicit DML after migrations run via ALTER DEFAULT PRIVILEGES:
ALTER DEFAULT PRIVILEGES FOR ROLE sbmigrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sbapp;
ALTER DEFAULT PRIVILEGES FOR ROLE sbmigrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sbapp;

-- Install citext (requires superuser; done here as vvpadmin)
CREATE EXTENSION IF NOT EXISTS citext;

-- Verify role isolation: sbmigrate cannot touch VVP databases (enforced at engine level
-- by absence of CONNECT grant on vvpissuer/pistis)
```

**Negative isolation verified** (see Test Strategy): `sbapp` and `sbmigrate` receive no CONNECT grant on `vvpissuer` or `pistis`.

### Phase 5 — TLS posture

All connection strings use `sslmode=verify-full` to validate the server certificate, not just encrypt the channel. Azure PostgreSQL Flexible Server uses the **DigiCert Global Root G2** CA. This CA is present in the standard system CA bundle (`ca-certificates`) on Debian/Ubuntu container images, which the singing-bridge Docker image is based on.

Connection string format:

```
postgres://sbapp:<pw>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=verify-full&sslrootcert=system
```

`sslrootcert=system` instructs libpq to use the OS-level CA bundle (`/etc/ssl/certs/ca-certificates.crt`) rather than a downloaded certificate file. This avoids certificate pinning maintenance while retaining full chain validation.

### Phase 6 — Credential storage (Key Vault + KV reference injection)

**Create shared Key Vault with purge protection and diagnostics:**

```bash
az keyvault create \
  --name rcnx-shared-kv \
  --resource-group rcnx-shared-rg \
  --location uksouth \
  --enable-rbac-authorization true \
  --enable-purge-protection true \
  --retention-days 7
```

**Store secrets:**

```bash
# Admin password (platform-only access enforced via RBAC below)
az keyvault secret set --vault-name rcnx-shared-kv \
  --name pg-admin-password --value '<vvpadmin-password>'

# Per-project connection strings
az keyvault secret set --vault-name rcnx-shared-kv \
  --name sb-migrate-url \
  --value 'postgres://sbmigrate:<pw-A>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=verify-full&sslrootcert=system'

az keyvault secret set --vault-name rcnx-shared-kv \
  --name sb-database-url \
  --value 'postgres://sbapp:<pw-B>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=verify-full&sslrootcert=system'
```

**RBAC grants:**

```bash
# Platform-only access to admin password
az role assignment create \
  --role "Key Vault Secrets Officer" \
  --assignee <platform-principal-id> \
  --scope "$(az keyvault show --name rcnx-shared-kv --query id -o tsv)/secrets/pg-admin-password"

# singing-bridge managed identity reads sb-database-url and sb-migrate-url
SB_IDENTITY=$(az containerapp show --name sb-server --resource-group sb-prod-rg \
  --query "identity.principalId" -o tsv)
KV_ID=$(az keyvault show --name rcnx-shared-kv --query id -o tsv)

az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee "$SB_IDENTITY" \
  --scope "$KV_ID/secrets/sb-database-url"

az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee "$SB_IDENTITY" \
  --scope "$KV_ID/secrets/sb-migrate-url"
```

**Enable diagnostic logging on the Key Vault** (audit all secret accesses):

```bash
az monitor diagnostic-settings create \
  --name kv-audit \
  --resource "$(az keyvault show --name rcnx-shared-kv --query id -o tsv)" \
  --logs '[{"category":"AuditEvent","enabled":true}]' \
  --workspace "$(az monitor log-analytics workspace list --resource-group sb-prod-rg \
    --query '[0].id' -o tsv)"
```

### Phase 7 — Wire singing-bridge Container App via KV reference

Use a Key Vault reference (not a raw secret value in Bicep parameters) so the connection string never appears in deployment history:

```bash
KV_URI=$(az keyvault show --name rcnx-shared-kv \
  --query "properties.vaultUri" -o tsv)

az containerapp secret set \
  --name sb-server --resource-group sb-prod-rg \
  --secrets "sb-db-url=keyvaultref:${KV_URI}secrets/sb-database-url,identityref:system"

az containerapp update \
  --name sb-server --resource-group sb-prod-rg \
  --set-env-vars "SB_DATABASE_URL=secretref:sb-db-url"
```

The application still boots on SQLite/`/tmp` (Sprint 19 changes the code). The env var is pre-positioned.

**Verify the revision starts healthy after secret injection:**

```bash
NEW_REV=$(az containerapp show --name sb-server --resource-group sb-prod-rg \
  --query "properties.latestRevisionName" -o tsv)

until [ "$(az containerapp revision show --name sb-server --resource-group sb-prod-rg \
  --revision "$NEW_REV" --query "properties.runningState" -o tsv)" != "Activating" ]
do sleep 5; done

az containerapp revision show --name sb-server --resource-group sb-prod-rg \
  --revision "$NEW_REV" --query "{state:properties.runningState,health:properties.healthState}" -o json
# Required: state=RunningAtMaxScale, health=Healthy
```

---

## Infrastructure as Code

### `infra/bicep/shared-postgres.bicep` (new)

Idempotent template covering public access, firewall rule, storage auto-grow, CITEXT server parameter, and `singing_bridge` database. Uses stable API version `2023-12-01`. Avoids shadowing the `resourceGroup()` built-in.

```bicep
// File: infra/bicep/shared-postgres.bicep
// Purpose: Shared PostgreSQL Flexible Server configuration — public access, firewall,
//          auto-grow, CITEXT allowlist, and per-project database provisioning.
// Role: Idempotent; safe to re-run. Does not manage passwords (out-of-band).
// Last updated: Sprint 18 (2026-04-24) -- initial

param location string = resourceGroup().location
param serverName string = 'vvp-postgres'
param sharedRg string = 'rcnx-shared-rg'

resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01' existing = {
  name: serverName
  scope: resourceGroup(sharedRg)
}

resource fwAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01' = {
  name: 'AllowAzureServices'
  parent: pgServer
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource citextParam 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01' = {
  name: 'azure.extensions'
  parent: pgServer
  properties: { value: 'citext', source: 'user-override' }
}

resource sbDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01' = {
  name: 'singing_bridge'
  parent: pgServer
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
```

### `infra/bicep/shared-keyvault.bicep` (new)

Key Vault with RBAC mode, purge protection, and diagnostic settings wired to the existing Log Analytics workspace.

### Update: `infra/bicep/container-app.bicep`

Add `SB_DATABASE_URL` env var (pointing at `secretref:sb-db-url`). No `SB_DATA_DIR` change yet — Sprint 19. Do **not** add `sbDatabaseUrl` as a Bicep secureString parameter; the secret is managed via KV reference at the CLI level to avoid exposure in deployment history.

### `knowledge/decisions/0002-shared-postgres-platform.md` (new)

Supersedes `0001-mvp-architecture.md` on the persistence decision. Records: move from SQLite to PostgreSQL, shared-server model, per-project role isolation, rationale (SMB locking, multi-project economics), consequences (Sprint 19 app migration required).

---

## Test Strategy

Ordered runbook — each step is a pass/fail gate. Stop and investigate before proceeding past any failure.

### Step 1 — Pre-flight

```bash
# Private endpoint approved
az postgres flexible-server show --name vvp-postgres --resource-group VVP \
  --query "privateEndpointConnections[0].privateLinkServiceConnectionState.status" -o tsv
# PASS: Approved

# VVP issuer healthy (DB-dependent)
curl -sf --max-time 10 \
  https://vvp-issuer.livelyglacier-e85ccac4.uksouth.azurecontainerapps.io/healthz
# PASS: HTTP 200

# pistis-backend revision healthy (no HTTP health probe; use ACA state)
az containerapp revision list --name pistis-backend --resource-group VVP \
  --query "[0].{state:properties.runningState,health:properties.healthState}" -o json
# PASS: state=Running, health=Healthy
```

### Step 2 — Bicep what-if (idempotency check)

```bash
az deployment group what-if \
  --resource-group rcnx-shared-rg \
  --template-file infra/bicep/shared-postgres.bicep
# PASS: no unexpected destructive changes listed
```

### Step 3 — Post-move regression (immediately after Phase 1)

```bash
# Private endpoint still Approved after RG move
az postgres flexible-server show --name vvp-postgres --resource-group rcnx-shared-rg \
  --query "privateEndpointConnections[0].privateLinkServiceConnectionState.status" -o tsv
# PASS: Approved (if Pending, re-approve and re-run)

# VVP issuer still healthy — within 2 minutes of move completion, with 30 s timeout per attempt
for i in 1 2 3 4; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    https://vvp-issuer.livelyglacier-e85ccac4.uksouth.azurecontainerapps.io/healthz)
  echo "attempt $i: $code"
  [ "$code" = "200" ] && break
  sleep 15
done
# PASS: at least one attempt returns 200 within observation window (4 × 15 s = 60 s)

# pistis-backend revision still healthy
az containerapp revision list --name pistis-backend --resource-group VVP \
  --query "[0].{state:properties.runningState,health:properties.healthState}" -o json
# PASS: state=Running, health=Healthy
```

**Rollback rule:** if `vvp-issuer /healthz` does not return 200 within the observation window, move `vvp-postgres` back to the `VVP` resource group before investigating.

### Step 4 — CITEXT extension verification

```bash
# Confirm azure.extensions server parameter accepted citext
az postgres flexible-server parameter show \
  --name vvp-postgres --resource-group rcnx-shared-rg \
  --parameter-name azure.extensions --query "value" -o tsv
# PASS: citext (or comma-separated list containing citext)

# Connect and verify extension installed in singing_bridge
psql "postgres://vvpadmin:<pw>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=verify-full&sslrootcert=system" \
  -c "SELECT extname, extversion FROM pg_extension WHERE extname = 'citext';"
# PASS: one row returned

# Smoke test: citext treats 'FOO' = 'foo'
psql "..." -c "SELECT 'FOO'::citext = 'foo'::citext;"
# PASS: returns t (true)
```

### Step 5 — Role isolation verification

```bash
# sbapp connects to singing_bridge (PASS)
psql "postgres://sbapp:<pw-B>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=verify-full&sslrootcert=system" \
  -c "SELECT current_user, current_database();"

# sbapp cannot connect to vvpissuer (PASS = connection refused / permission denied)
psql "postgres://sbapp:<pw-B>@vvp-postgres.postgres.database.azure.com/vvpissuer?sslmode=verify-full&sslrootcert=system" \
  -c "SELECT 1;" 2>&1 | grep -i "permission denied\|FATAL"

# sbmigrate can CREATE TABLE in singing_bridge (PASS)
psql "postgres://sbmigrate:<pw-A>@...singing_bridge?sslmode=verify-full&sslrootcert=system" \
  -c "CREATE TABLE _sprint18_probe (id int); DROP TABLE _sprint18_probe;"

# sbmigrate cannot connect to vvpissuer (PASS = permission denied)
psql "postgres://sbmigrate:<pw-A>@...vvpissuer?sslmode=verify-full&sslrootcert=system" \
  -c "SELECT 1;" 2>&1 | grep -i "permission denied\|FATAL"
```

### Step 6 — Key Vault secret readability (singing-bridge identity)

```bash
SB_IDENTITY=$(az containerapp show --name sb-server --resource-group sb-prod-rg \
  --query "identity.principalId" -o tsv)

# Confirm RBAC assignment exists for sb-database-url
az role assignment list \
  --assignee "$SB_IDENTITY" \
  --scope "$(az keyvault show --name rcnx-shared-kv --query id -o tsv)/secrets/sb-database-url" \
  --role "Key Vault Secrets User" \
  --query "[0].principalId" -o tsv
# PASS: returns the SB_IDENTITY value

# Verify secret is readable (using current dev identity as proxy; Container App identity
# is verified via successful revision startup in Step 7)
az keyvault secret show --vault-name rcnx-shared-kv --name sb-database-url \
  --query "value" -o tsv | grep -q "postgres://" && echo "PASS" || echo "FAIL"
```

### Step 7 — Container App secret injection and revision health

```bash
# Inject KV reference and verify revision reaches healthy state (see Phase 7 commands)
# PASS: state=RunningAtMaxScale, health=Healthy within 3 minutes
```

### Step 8 — Bicep idempotency (re-run)

```bash
az deployment group create \
  --resource-group rcnx-shared-rg \
  --template-file infra/bicep/shared-postgres.bicep \
  --what-if
# PASS: no changes detected on second run (idempotent)
```

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Private endpoint requires re-approval after RG move | Medium | Step 3 checks and re-approves if needed before proceeding |
| `AllowAzureServices` expands attack surface | Low-medium | `sslmode=verify-full` + strong passwords + `pg-admin-password` restricted to platform RBAC |
| DigiCert G2 CA missing from container image | Low | Debian-based images include it via `ca-certificates`; verified at connection test time |
| CITEXT `azure.extensions` parameter requires server restart | Low | Azure Flexible Server applies this parameter without restart; check in Step 4 |
| VVP Bicep breaks after RG move | Medium | FQDN is unchanged; VVP Bicep references server by name, not resource ID — verify pre-move |
| `ALTER DEFAULT PRIVILEGES` must be re-run per migration session | Low | Sprint 19 uses `sbmigrate` for DDL; `sbapp` needs explicit grants after each migration — document in Sprint 19 plan |

---

## Files changing

| File | Change | Owner |
|------|--------|-------|
| `infra/bicep/shared-postgres.bicep` | New: public access config, firewall rule, CITEXT parameter, `singing_bridge` database | singing-bridge repo |
| `infra/bicep/shared-keyvault.bicep` | New: `rcnx-shared-kv` with RBAC, purge protection, diagnostics | singing-bridge repo |
| `infra/bicep/container-app.bicep` | Add `SB_DATABASE_URL` env var referencing secret (no raw value in template) | singing-bridge repo |
| `knowledge/decisions/0002-shared-postgres-platform.md` | New ADR superseding SQLite decision in 0001 | singing-bridge repo |
| VVP bicep (`container-app.bicep` or equivalent) | Update server resource group reference: `VVP` → `rcnx-shared-rg` | VVP repo — coordinate before Phase 1 |

**No application code changes in this sprint.**

---

## Exit criteria

- `rcnx-shared-rg` exists; `vvp-postgres` is in it; private endpoint status `Approved`
- `AllowAzureServices` firewall rule confirmed; storage auto-grow enabled
- `citext` server parameter set and extension installed in `singing_bridge`; CITEXT smoke test passes
- `sbmigrate` and `sbapp` roles exist with correct grants; isolation verified (Steps 5)
- `rcnx-shared-kv` exists with purge protection, diagnostics, and all four secrets; RBAC grants confirmed
- `SB_DATABASE_URL` KV reference set in singing-bridge Container App; new revision `Healthy`
- VVP `vvp-issuer /healthz` → 200 and `pistis-backend` revision `Healthy` throughout
- `knowledge/decisions/0002-shared-postgres-platform.md` committed
- `infra/bicep/shared-postgres.bicep` idempotency confirmed (Step 8)
