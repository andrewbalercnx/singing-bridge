# ADR 0002 — Shared PostgreSQL Platform

**Status:** Accepted  
**Date:** 2026-04-24  
**Supersedes:** `0001-mvp-architecture.md` (SQLite persistence section)

---

## Context

The MVP architecture (ADR 0001) specified SQLite as the database engine for simplicity. During Sprint 16/17 we discovered that Azure Files SMB does not support POSIX byte-range advisory locks at any level — not just WAL mode. Even `DELETE` journal mode with a single container replica deadlocks due to SMB oplock persistence between container sessions. The only available workaround was `SB_DATA_DIR=/tmp`, making all data ephemeral (lost on every redeploy).

Two paths to durable persistence were evaluated:

1. **NFS Azure Files** — NFS v4.1 supports POSIX locks and would allow SQLite. Requires creating a new VNet-integrated Container Apps environment; cannot be added to the existing consumption-only `sb-env`. Heavy infra change (~4–6 hours, new environment with its own risks).

2. **PostgreSQL** — `vvp-postgres` (Standard_B1ms, PG 16, UK South) is already provisioned in the subscription, underused, and hosts only two databases. No new server cost. Azure PostgreSQL Flexible Server supports public access with credential + TLS controls, which is the only viable path given that `sb-env` has no VNet integration and overlapping address spaces block VNet peering.

RCNX is also building multiple projects (VVP, singing-bridge, pistis) on the same subscription. Each project provisioning its own postgres server costs ~£12/month per server. A shared server model eliminates this duplication.

---

## Decision

Promote `vvp-postgres` to a **shared, governed, multi-project PostgreSQL asset** under neutral ownership (`rcnx-shared-rg`), and migrate singing-bridge from SQLite to PostgreSQL.

**Shared server model:**
- One Azure PostgreSQL Flexible Server (`vvp-postgres`, Standard_B1ms) in `rcnx-shared-rg`
- Per-project databases (e.g., `singing_bridge`, `vvpissuer`, `pistis`)
- Per-project roles: `<project>migrate` (DDL, migrations only) and `<project>app` (DML, runtime only)
- Cross-project isolation enforced via `REVOKE CONNECT FROM PUBLIC` + explicit per-role `GRANT CONNECT`
- Credentials stored in `rcnx-shared-kv` (Azure Key Vault, RBAC mode)
- Runtime Container Apps read their own app-role secret only; DDL credentials accessible to operators

**Database isolation scope:** Per-database `REVOKE CONNECT FROM PUBLIC` enforces isolation between project databases (`singing_bridge`, `vvpissuer`, `pistis`). The `postgres` maintenance database is additionally revoked for application roles (`sbmigrate`, `sbapp`). Administrative access via `vvpadmin` (which holds `azure_pg_admin`) is unaffected by `CONNECT` revokes.

**Adding a new project (self-contained procedure):**

```sql
-- Run as vvpadmin on the postgres maintenance database
-- Precondition: database must first be created by Bicep (shared-postgres.bicep pattern)
CREATE ROLE <project>migrate LOGIN PASSWORD '<strong-password-A>';
GRANT CONNECT ON DATABASE <project_db> TO <project>migrate;
REVOKE CONNECT ON DATABASE postgres FROM <project>migrate;

CREATE ROLE <project>app LOGIN PASSWORD '<strong-password-B>';
GRANT CONNECT ON DATABASE <project_db> TO <project>app;
REVOKE CONNECT ON DATABASE postgres FROM <project>app;
REVOKE CONNECT ON DATABASE <project_db> FROM PUBLIC;
```

```bash
# Connect to <project_db> as <project>migrate and set default privileges
psql "postgres://<project>migrate:<pw-A>@vvp-postgres.postgres.database.azure.com/<project_db>?sslmode=require" <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO <project>app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO <project>app;
SQL

# Store in Key Vault
az keyvault secret set --vault-name rcnx-shared-kv \
  --name <project>-migrate-url --value 'postgres://<project>migrate:<pw-A>@...'
az keyvault secret set --vault-name rcnx-shared-kv \
  --name <project>-database-url --value 'postgres://<project>app:<pw-B>@...'

# Grant runtime identity access to app credential only
az role assignment create --role "Key Vault Secrets User" \
  --assignee <container-app-principal-id> \
  --scope "$(az keyvault show --name rcnx-shared-kv --query id -o tsv)/secrets/<project>-database-url"
```

---

## Consequences

**Positive:**
- Durable, ACID persistence without per-project server cost
- Centralised credential management via Key Vault RBAC
- Clear privilege separation: runtime application cannot execute DDL
- VVP developers unaffected — FQDN unchanged by resource-group move

**Negative / mitigations:**
- Single server is a shared failure domain. Mitigated by: storage auto-grow enabled; B1ms suitable for current load; server can be scaled up independently
- Public access enabled for singing-bridge connectivity (no VNet peering possible). Mitigated by: `AllowAzureServices` firewall rule; credential + TLS controls; server-side TLS enforced always
- Application TLS currently at `sslmode=require` (encrypts traffic, no cert validation). **Sprint 19 prerequisite:** enable `tls-rustls` or `tls-native-tls` sqlx feature for `verify-full` enforcement
- **Accepted risk — Key Vault public network access:** `rcnx-shared-kv` uses `publicNetworkAccess: Enabled` because `sb-env` is a consumption-only ACA environment with no fixed egress IP and no VNet integration. IP-based network ACLs cannot be scoped to the Container App's egress. Unauthenticated callers can reach the KV endpoint over the internet. This is mitigated by RBAC authorization (all operations require role assignment), per-secret scope (runtime identity scoped to its own credential only), AuditEvent logging to Log Analytics, and purge protection. If VNet integration becomes available in a future sprint, private endpoint access should be added and `publicNetworkAccess` disabled.

**Migration path:**
- Sprint 18 (this sprint): infra — shared RG, RG move, public access, CITEXT, per-project roles, Key Vault, Container App wiring
- Sprint 19: application — sqlx feature swap sqlite→postgres, SqlitePool→PgPool, migration files rewritten for PostgreSQL SQL dialect
