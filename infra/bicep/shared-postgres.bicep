// File: infra/bicep/shared-postgres.bicep
// Purpose: Idempotent configuration of shared postgres — AllowAzureServices firewall rule,
//          azure.extensions allowlist (includes citext), and singing_bridge database.
// Role: Declarative complement to the one-time CLI setup in PLAN_Sprint18.md.
//       Does not manage the server itself (public access and storage auto-grow are set
//       via CLI as one-time operations; adding them here would overwrite in-place changes).
// Exports: none
// Depends: vvp-postgres server in rcnx-shared-rg (existing resource, not managed here)
// Last updated: Sprint 18 (2026-04-24) -- initial

param serverName string = 'vvp-postgres'

resource pgServer 'Microsoft.DBforPostgreSQL/flexibleServers@2023-12-01' existing = {
  name: serverName
}

resource fwAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-12-01' = {
  name: 'AllowAzureServices'
  parent: pgServer
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// WARNING: Bicep is declarative and will set azure.extensions to this exact value.
// If other extensions are added later via CLI, they will be overwritten on the next deploy.
// Keep this list current with all required extensions across all projects on this server.
// The additive-append logic in PLAN_Sprint18.md Phase 3 applies to the initial CLI setup only.
resource azureExtensionsParam 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-12-01' = {
  name: 'azure.extensions'
  parent: pgServer
  properties: { value: 'citext', source: 'user-override' }
}

resource sbDatabase 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-12-01' = {
  name: 'singing_bridge'
  parent: pgServer
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}
