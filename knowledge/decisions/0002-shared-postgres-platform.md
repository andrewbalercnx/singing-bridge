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

**Adding a new project:**
1. Create a database and two roles on the shared server following the Phase 4 pattern in `PLAN_Sprint18.md`
2. Store credentials in `rcnx-shared-kv`
3. Grant `Key Vault Secrets User` on the app secret to the new project's Container App identity
4. Declare the KV reference in the project's Bicep `secrets` array

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

**Migration path:**
- Sprint 18 (this sprint): infra — shared RG, RG move, public access, CITEXT, per-project roles, Key Vault, Container App wiring
- Sprint 19: application — sqlx feature swap sqlite→postgres, SqlitePool→PgPool, migration files rewritten for PostgreSQL SQL dialect
