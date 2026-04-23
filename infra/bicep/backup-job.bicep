// File: infra/bicep/backup-job.bicep
// Purpose: Manual Container App Job for consistent SQLite backup to Azure Blob Storage.
// Role: Ops tooling — triggered manually or by CI; not in the critical path.
// Exports: jobName, jobId
// Last updated: Sprint 16 (2026-04-23) -- initial

param location string = resourceGroup().location
param jobName string = 'sb-backup-job'
param acrLoginServer string
// Must be supplied as a digest-pinned reference at deploy time, e.g.
// singing-bridge-backup@sha256:<digest>. No mutable-tag default is provided
// to prevent accidental deployment of an unpinned image in production.
param backupImageName string
// Container Apps Environment ID — must be the same environment as the main app
// so the NFS volume binding is accessible.
param caEnvId string
// ACA subnet ID from vnet.bicep — required to allow backup job egress to blob storage.
param acaSubnetId string
// Backup destination blob storage account.
param backupStorageAccountName string = 'sbbackup${uniqueString(resourceGroup().id)}'

// ---- Backup Blob Storage Account ----
resource backupStorageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: backupStorageAccountName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    networkAcls: {
      defaultAction: 'Deny'
      // Allow traffic from the Container Apps environment subnet so the backup
      // job can upload without exposing the account to the public internet.
      virtualNetworkRules: [
        {
          id: acaSubnetId
          action: 'Allow'
        }
      ]
      // Azure services bypass allows ARM deployments and portal access.
      bypass: 'AzureServices'
    }
  }
}

resource backupBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  name: '${backupStorageAccount.name}/default'
}

resource backupContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  name: '${backupBlobService.name}/backups'
  properties: {
    publicAccess: 'None'
  }
}

// ---- Backup Container App Job ----
// Triggered manually: az containerapp job start --name sb-backup-job --resource-group sb-prod-rg
// Uses system-assigned managed identity for blob upload — no shared keys.
// Pin the image by digest before first production deploy:
//   az acr manifest list-metadata --name singing-bridge-backup --registry sbprodacr
resource backupJob 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: caEnvId
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800  // 30 minutes; VACUUM INTO on a small DB completes in seconds
      replicaRetryLimit: 0  // no automatic retry — operator should verify and re-trigger
      registries: [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'backup'
          image: '${acrLoginServer}/${backupImageName}'
          env: [
            { name: 'BACKUP_STORAGE_ACCOUNT', value: backupStorageAccount.name }
            { name: 'BACKUP_CONTAINER', value: 'backups' }
            { name: 'DB_PATH', value: '/data/singing-bridge.db' }
          ]
          volumeMounts: [
            { volumeName: 'sb-data', mountPath: '/data' }
          ]
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          securityContext: {
            runAsNonRoot: true
            runAsUser: 65532
            runAsGroup: 65532
          }
        }
      ]
      volumes: [
        {
          name: 'sb-data'
          storageType: 'NfsAzureFile'
          storageName: 'sb-nfs-storage'
        }
      ]
    }
  }
}

// Scope the role to the backup container specifically, not the whole storage account.
// Storage Blob Data Contributor on the container is sufficient for upload.
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
resource backupRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(backupContainer.id, backupJob.id, storageBlobDataContributorRoleId)
  scope: backupContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: backupJob.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output jobName string = backupJob.name
output jobId string = backupJob.id
output backupStorageAccountName string = backupStorageAccount.name
