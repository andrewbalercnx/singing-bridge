// File: infra/bicep/vnet.bicep
// Purpose: VNet, ACA subnet, and storage subnet for NFS Azure Files.
// Role: Network foundation for Container Apps VNet integration and NFS storage access.
// Exports: vnetId, acaSubnetId, storageSubnetId
// Last updated: Sprint 16 (2026-04-23) -- initial

param location string = resourceGroup().location
param vnetName string = 'sb-vnet'

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  properties: {
    addressSpace: {
      addressPrefixes: ['10.0.0.0/16']
    }
    subnets: [
      {
        // /23 required minimum for Container Apps environment delegation.
        name: 'sb-aca-subnet'
        properties: {
          addressPrefix: '10.0.0.0/23'
          delegations: [
            {
              name: 'aca-delegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        // /28 is sufficient for the storage service endpoint; NFS traffic flows
        // over the Azure backbone — this subnet just enables the service endpoint.
        name: 'sb-storage-subnet'
        properties: {
          addressPrefix: '10.0.4.0/28'
          serviceEndpoints: [
            {
              service: 'Microsoft.Storage'
            }
          ]
        }
      }
    ]
  }
}

output vnetId string = vnet.id
output acaSubnetId string = vnet.properties.subnets[0].id
output storageSubnetId string = vnet.properties.subnets[1].id
