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
