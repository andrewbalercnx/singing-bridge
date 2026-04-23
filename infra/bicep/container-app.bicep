// File: infra/bicep/container-app.bicep
// Purpose: Container Apps environment + Azure Files storage + singing-bridge app + OMR sidecar.
// Role: Hosts the single-replica server with SQLite on Azure Files Premium.
// Invariants: min=max=1 replica (SQLite file-locking constraint). CF IP
//             allow-list codified in ipSecurityRestrictions (not a runbook step).
//             Ingress restricted to Cloudflare published IP ranges only.
//             SB_DATA_DIR=/tmp: Azure Files SMB deadlocks SQLite; DB is ephemeral until
//             PostgreSQL migration. The Azure Files volume remains mounted for future use.
// Last updated: Sprint 13 (2026-04-23) -- add sidecar container, ACS secret, SB_DATA_DIR=/tmp

param location string = resourceGroup().location
param environmentName string = 'sb-env'
param appName string = 'sb-server'
param acrLoginServer string
param imageName string = 'singing-bridge:latest'
param sidecarImageName string = 'singing-bridge-sidecar:latest'
param logWorkspaceCustomerId string
@secure()
param logWorkspaceKey string
param storageAccountName string = 'sbprod${uniqueString(resourceGroup().id)}'

// Secrets passed as secure parameters (never logged by ARM).
@secure()
param sbTurnSharedSecret string
@secure()
param sbCfWorkerUrl string
@secure()
param sbCfWorkerSecret string
@secure()
param sbSessionLogPepper string
@secure()
param sbSidecarSecret string
@secure()
param sbAcsConnectionString string

// ---- Storage Account + File Share ----
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: storageAccountName
  location: location
  kind: 'FileStorage'
  sku: { name: 'Premium_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    largeFileSharesState: 'Enabled'
  }
}

resource fileShare 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-01-01' = {
  name: '${storageAccount.name}/default/sb-data'
  properties: { shareQuota: 100 }
}

// ---- Container Apps Environment ----
resource caEnv 'Microsoft.App/managedEnvironments@2023-05-01' = {
  name: environmentName
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logWorkspaceCustomerId
        sharedKey: logWorkspaceKey
      }
    }
  }
}

// Attach Azure Files storage to the environment.
resource caStorage 'Microsoft.App/managedEnvironments/storages@2023-05-01' = {
  name: 'sb-data'
  parent: caEnv
  properties: {
    azureFile: {
      accountName: storageAccount.name
      accountKey: storageAccount.listKeys().keys[0].value
      shareName: 'sb-data'
      accessMode: 'ReadWrite'
    }
  }
}

// ---- Container App ----
resource app 'Microsoft.App/containerApps@2023-05-01' = {
  name: appName
  location: location
  identity: { type: 'SystemAssigned' }
  properties: {
    managedEnvironmentId: caEnv.id
    configuration: {
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
      }
      secrets: [
        { name: 'sb-turn-secret', value: sbTurnSharedSecret }
        { name: 'sb-cf-worker-url', value: sbCfWorkerUrl }
        { name: 'sb-cf-worker-secret', value: sbCfWorkerSecret }
        { name: 'sb-session-log-pepper', value: sbSessionLogPepper }
        { name: 'sb-sidecar-secret', value: sbSidecarSecret }
        { name: 'sb-acs-connection-string', value: sbAcsConnectionString }
      ]
      registries: [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ]
    }
    template: {
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
      volumes: [
        {
          name: 'sb-data'
          storageType: 'AzureFile'
          storageName: 'sb-data'
        }
      ]
      containers: [
        {
          name: 'server'
          image: '${acrLoginServer}/${imageName}'
          env: [
            { name: 'SB_ENV', value: 'prod' }
            { name: 'SB_BASE_URL', value: 'https://singing.rcnx.io' }
            { name: 'SB_DATA_DIR', value: '/tmp' }
            { name: 'SB_STATIC_DIR', value: '/app/web' }
            { name: 'SB_TURN_HOST', value: 'turn.singing.rcnx.io' }
            { name: 'SB_TURN_SHARED_SECRET', secretRef: 'sb-turn-secret' }
            { name: 'SB_CF_WORKER_URL', secretRef: 'sb-cf-worker-url' }
            { name: 'SB_CF_WORKER_SECRET', secretRef: 'sb-cf-worker-secret' }
            { name: 'SB_SESSION_LOG_PEPPER', secretRef: 'sb-session-log-pepper' }
            { name: 'SIDECAR_URL', value: 'http://localhost:5050' }
            { name: 'SIDECAR_SECRET', secretRef: 'sb-sidecar-secret' }
            { name: 'SB_ACS_CONNECTION_STRING', secretRef: 'sb-acs-connection-string' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          volumeMounts: [
            { volumeName: 'sb-data', mountPath: '/data' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8080 }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8080 }
              initialDelaySeconds: 3
              periodSeconds: 3
            }
          ]
        }
        {
          name: 'sidecar'
          image: '${acrLoginServer}/${sidecarImageName}'
          env: [
            { name: 'SIDECAR_SECRET', secretRef: 'sb-sidecar-secret' }
          ]
          resources: { cpu: json('1.0'), memory: '2Gi' }
        }
      ]
    }
  }
}

output appFqdn string = app.properties.configuration.ingress.fqdn
output appId string = app.id
