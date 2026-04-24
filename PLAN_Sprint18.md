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
| VVP app connectivity | `vvp-issuer` and `pistis-backend` reference postgres by **FQDN** (`vvp-postgres.postgres.database.azure.com`) in plain env vars — FQDN is unchanged by resource-group move, so **no VVP configuration changes are needed** |
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

### Phase 0 — Pre-flight

Record the current `azure.extensions` value for rollback, and confirm VVP health and private endpoint state before any changes.

```bash
# Record current azure.extensions value (append-safe update in Phase 3)
CURRENT_EXT=$(az postgres flexible-server parameter show \
  --name vvp-postgres --resource-group VVP \
  --parameter-name azure.extensions --query "value" -o tsv)
echo "Current azure.extensions: $CURRENT_EXT"  # record for rollback

# Private endpoint approved
az postgres flexible-server show --name vvp-postgres --resource-group VVP \
  --query "privateEndpointConnections[0].privateLinkServiceConnectionState.status" -o tsv
# PASS: Approved

# VVP issuer healthy
curl -sf --max-time 10 \
  https://vvp-issuer.livelyglacier-e85ccac4.uksouth.azurecontainerapps.io/healthz
# PASS: HTTP 200

# pistis-backend revision healthy
az containerapp revision list --name pistis-backend --resource-group VVP \
  --query "[0].{state:properties.runningState,health:properties.healthState}" -o json
# PASS: state=Running, health=Healthy
```

### Phase 1 — Governance: move server to shared resource group

```bash
az group create --name rcnx-shared-rg --location uksouth

az resource move \
  --destination-group rcnx-shared-rg \
  --ids $(az postgres flexible-server show \
    --name vvp-postgres --resource-group VVP --query id -o tsv)
```

After the move, verify the private endpoint connection state. Resource-group moves change the server's resource ID, which can require re-approval:

```bash
STATUS=$(az postgres flexible-server show --name vvp-postgres \
  --resource-group rcnx-shared-rg \
  --query "privateEndpointConnections[0].privateLinkServiceConnectionState.status" -o tsv)
echo "PE status: $STATUS"

# If Pending, re-approve:
if [ "$STATUS" = "Pending" ]; then
  CONN_NAME=$(az postgres flexible-server show --name vvp-postgres \
    --resource-group rcnx-shared-rg \
    --query "privateEndpointConnections[0].name" -o tsv)
  az network private-endpoint-connection approve \
    --name "$CONN_NAME" \
    --resource-group rcnx-shared-rg \
    --resource-name vvp-postgres \
    --type Microsoft.DBforPostgreSQL/flexibleServers \
    --description "Re-approved after RG move"
fi
```

VVP applications use the FQDN `vvp-postgres.postgres.database.azure.com` which is **unchanged** by this move. No VVP configuration changes are needed.

**Rollback:** `az resource move --destination-group VVP --ids $(az postgres flexible-server show --name vvp-postgres --resource-group rcnx-shared-rg --query id -o tsv)`

### Phase 2 — Networking: enable public access + storage auto-grow

```bash
az postgres flexible-server update \
  --name vvp-postgres --resource-group rcnx-shared-rg \
  --public-access Enabled \
  --storage-auto-grow Enabled

az postgres flexible-server firewall-rule create \
  --name vvp-postgres --resource-group rcnx-shared-rg \
  --rule-name AllowAzureServices \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
```

The private endpoint to `vvp-vnet` is **not affected** — both access paths coexist.

### Phase 3 — CITEXT extension: additive allowlist update

The `azure.extensions` parameter is a comma-separated allowlist. Overwriting it blindly would remove extensions already allowlisted for other databases. The update must **append** `citext` only if absent:

```bash
CURRENT_EXT=$(az postgres flexible-server parameter show \
  --name vvp-postgres --resource-group rcnx-shared-rg \
  --parameter-name azure.extensions --query "value" -o tsv)

# Append citext only if not already present
if echo "$CURRENT_EXT" | grep -qiw "citext"; then
  echo "citext already in azure.extensions — no change needed"
else
  NEW_EXT="${CURRENT_EXT:+${CURRENT_EXT},}citext"
  az postgres flexible-server parameter set \
    --name vvp-postgres --resource-group rcnx-shared-rg \
    --parameter-name azure.extensions \
    --value "$NEW_EXT"
fi
```

**Rollback:** `az postgres flexible-server parameter set --value "$CURRENT_EXT"` (using value recorded in Phase 0).

### Phase 4 — Per-project isolation: database and roles

Two roles per project: **`sbmigrate`** (DDL for migrations) and **`sbapp`** (DML for the running application). The application never holds DDL capability.

**Generate passwords before running the SQL block** — use a method that avoids shell-history leakage:

```bash
# Generate 32-char alphanumeric passwords (no shell-special chars that break connection strings)
openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32
# Run twice: once for PW_A (sbmigrate), once for PW_B (sbapp).
# Store in a local password manager immediately — never write to shell history.
# To avoid history exposure: prefix the assignment with a space, or use `read -rs PW_A`.
```

```sql
-- Run as vvpadmin on the postgres maintenance database

CREATE DATABASE singing_bridge;

-- Enforce per-database isolation.
-- PostgreSQL grants CONNECT to PUBLIC by default. Revoke it from all shared databases
-- so only explicitly named roles can connect to their own database.
REVOKE CONNECT ON DATABASE singing_bridge FROM PUBLIC;
REVOKE CONNECT ON DATABASE vvpissuer FROM PUBLIC;
REVOKE CONNECT ON DATABASE pistis FROM PUBLIC;
-- Note: vvpadmin holds azure_pg_admin which bypasses CONNECT restrictions —
-- the revoke does not affect administrative access.

-- Migration role (DDL)
CREATE ROLE sbmigrate LOGIN PASSWORD '<pw-A>';
GRANT CONNECT ON DATABASE singing_bridge TO sbmigrate;

-- Runtime role (DML only)
CREATE ROLE sbapp LOGIN PASSWORD '<pw-B>';
GRANT CONNECT ON DATABASE singing_bridge TO sbapp;
```

Connect to `singing_bridge` as `vvpadmin`:

```sql
\c singing_bridge

-- sbmigrate owns the schema and creates all objects
GRANT CREATE ON SCHEMA public TO sbmigrate;
GRANT USAGE ON SCHEMA public TO sbmigrate;

-- sbapp needs schema USAGE explicitly (not relying on PUBLIC default)
GRANT USAGE ON SCHEMA public TO sbapp;

-- Install citext (requires superuser; done here as vvpadmin)
CREATE EXTENSION IF NOT EXISTS citext;
```

**`ALTER DEFAULT PRIVILEGES` must be run as `sbmigrate`**, not as `vvpadmin`, because default privileges apply to objects created by the role executing the statement. Connect as `sbmigrate`:

```bash
psql "postgres://sbmigrate:<pw-A>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=require" <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sbapp;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sbapp;
SQL
```

This ensures every table and sequence that Sprint 19 migrations create will be immediately accessible to `sbapp` without additional grants.

**Role isolation** (enforced at the PostgreSQL engine level): The `REVOKE CONNECT FROM PUBLIC` statements above ensure `sbmigrate` and `sbapp` cannot connect to `vvpissuer` or `pistis`, and no unenumerated role can connect to `singing_bridge`. Any unauthorised connection attempt returns `FATAL: permission denied for database`.

### Phase 5 — TLS posture

All connection strings use `sslmode=require`, which encrypts traffic. Azure PostgreSQL Flexible Server enforces TLS for all connections regardless of client setting.

**Management commands** (psql CLI, this sprint): may additionally use `sslrootcert=system` to verify the server certificate chain:
```
postgres://vvpadmin:<pw>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=verify-full&sslrootcert=system
```

**Application connection strings** stored in Key Vault use `sslmode=require` only, which is what sqlx supports natively. `sslrootcert=system` is a libpq-specific parameter not honoured by sqlx. Full certificate validation from the application side (`verify-full` equivalent in sqlx) requires enabling the `tls-rustls` or `tls-native-tls` feature alongside `postgres` in sqlx — this is a **Sprint 19 prerequisite**, documented in `PLAN_Sprint19.md` under Cargo feature flags.

Connection string stored in Key Vault:
```
postgres://sbapp:<pw-B>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=require
```

### Phase 6 — Credential storage (Key Vault)

```bash
az keyvault create \
  --name rcnx-shared-kv \
  --resource-group rcnx-shared-rg \
  --location uksouth \
  --enable-rbac-authorization true \
  --enable-purge-protection true \
  --retention-days 7

az keyvault secret set --vault-name rcnx-shared-kv \
  --name pg-admin-password --value '<vvpadmin-password>'

az keyvault secret set --vault-name rcnx-shared-kv \
  --name sb-migrate-url \
  --value 'postgres://sbmigrate:<pw-A>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=require'

az keyvault secret set --vault-name rcnx-shared-kv \
  --name sb-database-url \
  --value 'postgres://sbapp:<pw-B>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=require'
```

**RBAC grants:**

The runtime Container App identity receives access to `sb-database-url` only. The migration credential (`sb-migrate-url`) must not be readable by the runtime identity — granting it would defeat the privilege split between the runtime application and the DDL-capable migration role.

```bash
KV_ID=$(az keyvault show --name rcnx-shared-kv --query id -o tsv)
SB_IDENTITY=$(az containerapp show --name sb-server --resource-group sb-prod-rg \
  --query "identity.principalId" -o tsv)
OPERATOR_ID=$(az ad signed-in-user show --query id -o tsv)

# Admin password: operator only
az role assignment create \
  --role "Key Vault Secrets Officer" \
  --assignee "$OPERATOR_ID" \
  --scope "$KV_ID/secrets/pg-admin-password"

# Runtime identity reads the app connection string only
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee "$SB_IDENTITY" \
  --scope "$KV_ID/secrets/sb-database-url"

# Migration URL: operator identity only (for running Sprint 19 sqlx migrations)
# A dedicated migration job identity may be added in Sprint 19 if automation is required.
az role assignment create \
  --role "Key Vault Secrets User" \
  --assignee "$OPERATOR_ID" \
  --scope "$KV_ID/secrets/sb-migrate-url"
```

**Enable diagnostic logging:**

```bash
az monitor diagnostic-settings create \
  --name kv-audit \
  --resource "$KV_ID" \
  --logs '[{"category":"AuditEvent","enabled":true}]' \
  --workspace "$(az monitor log-analytics workspace list \
    --resource-group sb-prod-rg --query '[0].id' -o tsv)"
```

### Phase 7 — Wire singing-bridge Container App (Bicep-authoritative)

The `sb-db-url` secret is declared in `infra/bicep/container-app.bicep` using a Key Vault reference, so a fresh Bicep redeploy preserves it without CLI repair. The raw value never appears in deployment history.

In `container-app.bicep`, add to the `secrets` array (see Files Changing section for full Bicep snippet) and add to the `env` array of the server container:

```bicep
// In secrets array:
{ name: 'sb-db-url', keyVaultUrl: '${sharedKvUri}secrets/sb-database-url', identity: 'system' }

// In server container env array:
{ name: 'SB_DATABASE_URL', secretRef: 'sb-db-url' }
```

`sharedKvUri` is a new non-secret parameter: `param sharedKvUri string = 'https://rcnx-shared-kv.vault.azure.net/'`.

For the Bicep KV reference to succeed, the Container App's system-assigned identity needs `Key Vault Secrets User` on the secret — granted in Phase 6. The Bicep deployment must be run after the RBAC grant propagates (~30 seconds).

After deploying the updated Bicep, verify the new revision is healthy:

```bash
NEW_REV=$(az containerapp show --name sb-server --resource-group sb-prod-rg \
  --query "properties.latestRevisionName" -o tsv)

until [ "$(az containerapp revision show --name sb-server --resource-group sb-prod-rg \
  --revision "$NEW_REV" --query "properties.runningState" -o tsv 2>/dev/null)" \
  != "Activating" ]; do sleep 5; done

az containerapp revision show --name sb-server --resource-group sb-prod-rg \
  --revision "$NEW_REV" \
  --query "{state:properties.runningState,health:properties.healthState}" -o json
# REQUIRED: state=RunningAtMaxScale, health=Healthy
# If Failed: az containerapp logs show --name sb-server --resource-group sb-prod-rg --tail 30
```

---

## Infrastructure as Code

### `infra/bicep/shared-postgres.bicep` (new)

Manages firewall rule, CITEXT server parameter, and `singing_bridge` database on the existing (moved) server. Does **not** manage the server resource itself (public access and storage auto-grow are set via CLI as one-time operations that would be overwritten by idempotent Bicep; they can be added to the template in a follow-up).

```bicep
// File: infra/bicep/shared-postgres.bicep
// Purpose: Idempotent configuration of shared postgres — AllowAzureServices firewall rule,
//          CITEXT extension allowlist, and singing_bridge database.
// Role: Declarative complement to the one-time CLI setup in PLAN_Sprint18.md.
// Exports: none
// Depends: vvp-postgres server in rcnx-shared-rg (existing resource, not managed here)
// Last updated: Sprint 18 (2026-04-24) -- initial

param location string = resourceGroup().location
param serverName string = 'vvp-postgres'

resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01' existing = {
  name: serverName
}

resource fwAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01' = {
  name: 'AllowAzureServices'
  parent: pgServer
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource azureExtensionsParam 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01' = {
  name: 'azure.extensions'
  parent: pgServer
  // WARNING: this overwrites the full list. Pre-flight (Phase 0) records existing value.
  // Operator must manually include all existing extensions in this value.
  properties: { value: 'citext', source: 'user-override' }
}

resource sbDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01' = {
  name: 'singing_bridge'
  parent: pgServer
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
```

**Note on `azure.extensions` in Bicep:** Bicep is declarative and will set the value as written. If other extensions are added later via CLI (e.g., `uuid-ossp` for another project), those additions will be overwritten on the next Bicep deployment. The operator must keep this value current with all required extensions. The additive-append logic in Phase 3 applies to the initial one-time CLI setup only.

### `infra/bicep/shared-keyvault.bicep` (new)

```bicep
// File: infra/bicep/shared-keyvault.bicep
// Purpose: Shared Key Vault (rcnx-shared-kv) for cross-project secrets — RBAC mode,
//          purge protection, audit diagnostics.
// Role: Authoritative for vault-level config; secrets and RBAC are managed via CLI.
// Exports: keyVaultUri (output)
// Depends: Log Analytics workspace in sb-prod-rg (for diagnostics)
// Last updated: Sprint 18 (2026-04-24) -- initial

param location string = resourceGroup().location
param kvName string = 'rcnx-shared-kv'
param logWorkspaceId string

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enablePurgeProtection: true
    softDeleteRetentionInDays: 7
    publicNetworkAccess: 'Enabled'
  }
}

resource kvDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'kv-audit'
  scope: kv
  properties: {
    workspaceId: logWorkspaceId
    logs: [{ category: 'AuditEvent', enabled: true }]
  }
}

output keyVaultUri string = kv.properties.vaultUri
```

### Update: `infra/bicep/container-app.bicep`

Add `sharedKvUri` parameter and `sb-db-url` KV-reference secret. The secret is declared in the `secrets` array alongside existing secrets, making Bicep the authoritative source:

```bicep
// New parameter (non-secret; just the vault URI)
param sharedKvUri string = 'https://rcnx-shared-kv.vault.azure.net/'

// In configuration.secrets array, add:
{ name: 'sb-db-url', keyVaultUrl: '${sharedKvUri}secrets/sb-database-url', identity: 'system' }

// In server container env array, add:
{ name: 'SB_DATABASE_URL', secretRef: 'sb-db-url' }
```

The container app's `identity: { type: 'SystemAssigned' }` (already present) satisfies the `identity: 'system'` reference.

### `knowledge/decisions/0002-shared-postgres-platform.md` (new)

Supersedes the SQLite persistence decision in `0001-mvp-architecture.md`. Records:
- Decision: PostgreSQL as the shared persistence backend for all RCNX projects
- Shared-server model: one Flexible Server in `rcnx-shared-rg`, per-project databases and roles
- Rationale: Azure Files SMB does not support SQLite advisory locking; shared server eliminates per-project server costs
- Migration path: Sprint 18 (infra) → Sprint 19 (application migration)
- Consequences: SQLite migrations rewritten for Postgres in Sprint 19; `DATABASE_TEST_URL` required for integration tests

---

## Test Strategy

Ordered runbook — each step is a pass/fail gate. Stop and investigate before proceeding past any failure.

### Step 1 — Pre-flight (Phase 0)

```bash
# Private endpoint Approved
az postgres flexible-server show --name vvp-postgres --resource-group VVP \
  --query "privateEndpointConnections[0].privateLinkServiceConnectionState.status" -o tsv
# PASS: Approved

# VVP issuer healthy
curl -sf --max-time 10 \
  https://vvp-issuer.livelyglacier-e85ccac4.uksouth.azurecontainerapps.io/healthz
# PASS: HTTP 200

# pistis-backend healthy
az containerapp revision list --name pistis-backend --resource-group VVP \
  --query "[0].{state:properties.runningState,health:properties.healthState}" -o json
# PASS: state=Running, health=Healthy
```

### Step 2 — Bicep what-if (both templates, before deploy)

```bash
az deployment group what-if \
  --resource-group rcnx-shared-rg \
  --template-file infra/bicep/shared-postgres.bicep
# PASS: no unexpected destructive changes

az deployment group what-if \
  --resource-group rcnx-shared-rg \
  --template-file infra/bicep/shared-keyvault.bicep \
  --parameters logWorkspaceId=<workspace-id>
# PASS: no unexpected destructive changes
```

### Step 3 — Post-RG-move regression (immediately after Phase 1)

```bash
# Private endpoint still Approved
az postgres flexible-server show --name vvp-postgres --resource-group rcnx-shared-rg \
  --query "privateEndpointConnections[0].privateLinkServiceConnectionState.status" -o tsv
# PASS: Approved (re-approve if Pending using script in Phase 1)

# VVP issuer — 4 attempts × 15 s = 60 s observation window
for i in 1 2 3 4; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    https://vvp-issuer.livelyglacier-e85ccac4.uksouth.azurecontainerapps.io/healthz)
  echo "attempt $i: $code"; [ "$code" = "200" ] && break; sleep 15
done
# PASS: at least one 200 within window
# ROLLBACK trigger: no 200 within window → move server back to VVP RG

# pistis-backend healthy
az containerapp revision list --name pistis-backend --resource-group VVP \
  --query "[0].{state:properties.runningState,health:properties.healthState}" -o json
# PASS: state=Running, health=Healthy
```

### Step 4 — CITEXT verification

```bash
# Server parameter contains citext
az postgres flexible-server parameter show \
  --name vvp-postgres --resource-group rcnx-shared-rg \
  --parameter-name azure.extensions --query "value" -o tsv | grep -i citext
# PASS: citext present in value

# Extension installed and functional in singing_bridge
psql "postgres://vvpadmin:<pw>@vvp-postgres.postgres.database.azure.com/singing_bridge?sslmode=require" <<'SQL'
SELECT extname, extversion FROM pg_extension WHERE extname = 'citext';
-- PASS: one row returned
SELECT 'FOO'::citext = 'foo'::citext AS citext_works;
-- PASS: returns t
SQL
```

### Step 5 — Role isolation

```bash
PG_HOST="vvp-postgres.postgres.database.azure.com"

# sbapp connects to singing_bridge ✓
psql "postgres://sbapp:<pw-B>@${PG_HOST}/singing_bridge?sslmode=require" \
  -c "SELECT current_user, current_database();"
# PASS: one row returned

# sbmigrate can CREATE TABLE in singing_bridge ✓
psql "postgres://sbmigrate:<pw-A>@${PG_HOST}/singing_bridge?sslmode=require" \
  -c "CREATE TABLE _sprint18_probe (id int); DROP TABLE _sprint18_probe;"
# PASS: no error

# sbapp can SELECT, INSERT, DELETE on table created by sbmigrate (default privileges) ✓
psql "postgres://sbmigrate:<pw-A>@${PG_HOST}/singing_bridge?sslmode=require" \
  -c "CREATE TABLE _priv_probe (id int);"
psql "postgres://sbapp:<pw-B>@${PG_HOST}/singing_bridge?sslmode=require" <<'SQL'
SELECT * FROM _priv_probe;
INSERT INTO _priv_probe VALUES (1);
DELETE FROM _priv_probe WHERE id = 1;
SQL
psql "postgres://sbmigrate:<pw-A>@${PG_HOST}/singing_bridge?sslmode=require" \
  -c "DROP TABLE _priv_probe;"
# PASS: all three statements succeed; DROP succeeds (cleanup)

# sbapp cannot connect to vvpissuer ✗ (expected failure)
psql "postgres://sbapp:<pw-B>@${PG_HOST}/vvpissuer?sslmode=require" \
  -c "SELECT 1;" 2>&1 | grep -i "permission denied\|FATAL"
# PASS: error message contains permission denied

# sbapp cannot connect to pistis ✗ (expected failure)
psql "postgres://sbapp:<pw-B>@${PG_HOST}/pistis?sslmode=require" \
  -c "SELECT 1;" 2>&1 | grep -i "permission denied\|FATAL"
# PASS: error message contains permission denied

# sbmigrate cannot connect to vvpissuer ✗ (expected failure)
psql "postgres://sbmigrate:<pw-A>@${PG_HOST}/vvpissuer?sslmode=require" \
  -c "SELECT 1;" 2>&1 | grep -i "permission denied\|FATAL"
# PASS: error message contains permission denied

# sbmigrate cannot connect to pistis ✗ (expected failure)
psql "postgres://sbmigrate:<pw-A>@${PG_HOST}/pistis?sslmode=require" \
  -c "SELECT 1;" 2>&1 | grep -i "permission denied\|FATAL"
# PASS: error message contains permission denied
```

### Step 6 — Key Vault secret readability and access boundaries

```bash
KV_ID=$(az keyvault show --name rcnx-shared-kv --query id -o tsv)
SB_IDENTITY=$(az containerapp show --name sb-server --resource-group sb-prod-rg \
  --query "identity.principalId" -o tsv)

# --- Positive: runtime identity can read sb-database-url ---
az role assignment list \
  --assignee "$SB_IDENTITY" \
  --scope "$KV_ID/secrets/sb-database-url" \
  --role "Key Vault Secrets User" \
  --query "[0].principalId" -o tsv
# PASS: returns SB_IDENTITY

az keyvault secret show --vault-name rcnx-shared-kv --name sb-database-url \
  --query "value" -o tsv | grep -q "postgres://" && echo "PASS: sb-database-url readable" || echo "FAIL"

# --- Negative: runtime identity has NO assignment on sb-migrate-url ---
MIGRATE_ASSIGNMENTS=$(az role assignment list \
  --assignee "$SB_IDENTITY" \
  --scope "$KV_ID/secrets/sb-migrate-url" \
  --role "Key Vault Secrets User" \
  --query "length(@)" -o tsv)
[ "$MIGRATE_ASSIGNMENTS" = "0" ] \
  && echo "PASS: runtime identity has no access to sb-migrate-url" \
  || echo "FAIL: runtime identity must not hold sb-migrate-url assignment"

# --- sb-migrate-url readable by operator (under current CLI identity) ---
az keyvault secret show --vault-name rcnx-shared-kv --name sb-migrate-url \
  --query "value" -o tsv | grep -q "postgres://sbmigrate" \
  && echo "PASS: sb-migrate-url readable by operator" || echo "FAIL"
```

### Step 7 — Container App revision health after Bicep deploy

```bash
# Deploy updated container-app.bicep (see Phase 7 for full parameter list)
az deployment group create \
  --resource-group sb-prod-rg \
  --template-file infra/bicep/container-app.bicep \
  --parameters sharedKvUri='https://rcnx-shared-kv.vault.azure.net/' \
    [... other existing params ...]

NEW_REV=$(az containerapp show --name sb-server --resource-group sb-prod-rg \
  --query "properties.latestRevisionName" -o tsv)

until [ "$(az containerapp revision show --name sb-server --resource-group sb-prod-rg \
  --revision "$NEW_REV" --query "properties.runningState" -o tsv 2>/dev/null)" \
  != "Activating" ]; do sleep 5; done

az containerapp revision show --name sb-server --resource-group sb-prod-rg \
  --revision "$NEW_REV" \
  --query "{state:properties.runningState,health:properties.healthState}" -o json
# PASS: state=RunningAtMaxScale, health=Healthy
# FAIL action: az containerapp logs show --name sb-server --resource-group sb-prod-rg --tail 30
```

### Step 8 — Bicep idempotency (re-run both templates)

```bash
az deployment group create --resource-group rcnx-shared-rg \
  --template-file infra/bicep/shared-postgres.bicep --what-if
# PASS: no changes

az deployment group create --resource-group rcnx-shared-rg \
  --template-file infra/bicep/shared-keyvault.bicep \
  --parameters logWorkspaceId=<workspace-id> --what-if
# PASS: no changes
```

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Private endpoint requires re-approval after RG move | Medium | Phase 1 includes conditional re-approval script |
| `azure.extensions` Bicep overwrites future CLI additions | Medium | Documented in template comment; operator must keep Bicep value current |
| `ALTER DEFAULT PRIVILEGES` not effective for existing tables | Low | Only applies to future objects; Sprint 19 starts with empty DB so all tables are future |
| RBAC grant propagation delay before Bicep deploy | Low | Phase 7 notes 30 s wait; az deployment will fail fast with clear error if KV read denied |
| VVP apps broken by RG move | Very low | FQDN unchanged; verified in Step 3 within 60 s observation window with rollback trigger |
| `sslrootcert=system` not supported by sqlx | Acknowledged | App connection string uses `sslmode=require` only; full cert validation is a Sprint 19 task |

---

## Files changing

| File | Change |
|------|--------|
| `infra/bicep/shared-postgres.bicep` | New: firewall rule, CITEXT parameter, `singing_bridge` database |
| `infra/bicep/shared-keyvault.bicep` | New: `rcnx-shared-kv` with RBAC, purge protection, diagnostics |
| `infra/bicep/container-app.bicep` | Add `sharedKvUri` param; add `sb-db-url` KV-ref secret; add `SB_DATABASE_URL` env var |
| `knowledge/decisions/0002-shared-postgres-platform.md` | New ADR superseding SQLite decision |
| VVP infra | **No change required** — VVP apps reference postgres by FQDN (unchanged by RG move) |

---

## Exit criteria

- `rcnx-shared-rg` exists; `vvp-postgres` is in it; private endpoint status `Approved`
- `AllowAzureServices` firewall rule confirmed; storage auto-grow enabled
- `azure.extensions` contains `citext`; extension installed in `singing_bridge`; citext smoke test passes (Step 4)
- `sbmigrate` and `sbapp` roles exist with correct grants; all Step 5 isolation checks pass (including negative access to both `vvpissuer` and `pistis`)
- `rcnx-shared-kv` exists with purge protection, diagnostics; runtime identity RBAC confirmed for `sb-database-url`; runtime identity confirmed to have NO access to `sb-migrate-url` (Step 6)
- `SB_DATABASE_URL` KV reference declared in `container-app.bicep`; new revision `Healthy` (Step 7)
- VVP `vvp-issuer /healthz` → 200 and `pistis-backend` revision `Healthy` throughout (Steps 1, 3)
- `knowledge/decisions/0002-shared-postgres-platform.md` committed
- Both Bicep templates idempotent (Step 8)
- **Accepted residual risk (Sprint 18):** Application connection strings use `sslmode=require`, which encrypts traffic but does not validate the server certificate chain. This is the limit of what sqlx supports without the `tls-rustls` or `tls-native-tls` Cargo feature enabled.
- **Sprint 19 mandatory entry condition:** The `tls-rustls` (or `tls-native-tls`) feature must be added to the `sqlx` dependency in `server/Cargo.toml` alongside `postgres` before claiming `verify-full` application TLS enforcement. This sprint does not claim that enforcement.
