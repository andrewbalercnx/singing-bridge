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
    softDeleteRetentionInDays: 90
    // Public access is required: sb-env is a consumption-only ACA environment with no fixed
    // egress IP and no VNet integration, so IP-based network ACLs cannot be used.
    // Accepted risk: unauthenticated callers can reach the KV endpoint over the internet.
    // Controls: RBAC authorization (all secrets require role assignment); per-secret scope;
    // AuditEvent logging; purge protection prevents deletion.
    // Reviewed and accepted in ADR 0002 (knowledge/decisions/0002-shared-postgres-platform.md).
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
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
