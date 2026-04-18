// File: infra/bicep/acr.bicep
// Purpose: Azure Container Registry — Basic SKU, admin disabled.
// Role: Image store for the singing-bridge server container.
// Last updated: Sprint 5 (2026-04-18) -- initial implementation

param location string = resourceGroup().location
param acrName string = 'sbprodacr'

resource acr 'Microsoft.ContainerRegistry/registries@2023-01-01-preview' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

output acrLoginServer string = acr.properties.loginServer
output acrId string = acr.id
