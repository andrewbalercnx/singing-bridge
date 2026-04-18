// File: infra/bicep/log-analytics.bicep
// Purpose: Log Analytics workspace for Container App diagnostics + VM logs.
// Last updated: Sprint 5 (2026-04-18) -- initial implementation

param location string = resourceGroup().location
param workspaceName string = 'sb-logs'

resource workspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: workspaceName
  location: location
  properties: {
    retentionInDays: 30
    sku: { name: 'PerGB2018' }
  }
}

output workspaceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId
output workspaceSharedKey string = workspace.listKeys().primarySharedKey
