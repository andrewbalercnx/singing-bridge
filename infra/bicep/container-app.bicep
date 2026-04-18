// File: infra/bicep/container-app.bicep
// Purpose: Container Apps environment + Azure Files storage + singing-bridge app.
// Role: Hosts the single-replica server with SQLite on Azure Files Premium.
// Invariants: min=max=1 replica (SQLite file-locking constraint). CF IP
//             allow-list codified in ipSecurityRestrictions (not a runbook step).
//             Ingress restricted to Cloudflare published IP ranges only.
// Last updated: Sprint 5 (2026-04-18) -- initial implementation

param location string = resourceGroup().location
param environmentName string = 'sb-env'
param appName string = 'sb-server'
param acrLoginServer string
param imageName string = 'singing-bridge:latest'
param logWorkspaceCustomerId string
@secure()
param logWorkspaceKey string
param storageAccountName string = 'sbprodstorage${uniqueString(resourceGroup().id)}'

// ---- Cloudflare published IPv4 ranges (update when CF publishes new ranges) ----
// Source: https://www.cloudflare.com/ips-v4
// Runbook: knowledge/runbook/deploy.md § CF IP range refresh
param cfIpRanges array = [
  '173.245.48.0/20'
  '103.21.244.0/22'
  '103.22.200.0/22'
  '103.31.4.0/22'
  '141.101.64.0/18'
  '108.162.192.0/18'
  '190.93.240.0/20'
  '188.114.96.0/20'
  '197.234.240.0/22'
  '198.41.128.0/17'
  '162.158.0.0/15'
  '104.16.0.0/13'
  '104.24.0.0/14'
  '172.64.0.0/13'
  '131.0.72.0/22'
]

// Secrets passed as secure parameters (never logged by ARM).
@secure()
param sbTurnSharedSecret string
@secure()
param sbCfWorkerUrl string
@secure()
param sbCfWorkerSecret string
@secure()
param sbSessionLogPepper string

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

// ---- IP security restrictions from CF ranges ----
var ipRestrictions = [for (range, i) in cfIpRanges: {
  name: 'cloudflare-${i}'
  action: 'Allow'
  ipAddressRange: range
}]

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
        ipSecurityRestrictions: ipRestrictions
      }
      secrets: [
        { name: 'sb-turn-secret', value: sbTurnSharedSecret }
        { name: 'sb-cf-worker-url', value: sbCfWorkerUrl }
        { name: 'sb-cf-worker-secret', value: sbCfWorkerSecret }
        { name: 'sb-session-log-pepper', value: sbSessionLogPepper }
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
            { name: 'SB_DATA_DIR', value: '/data' }
            { name: 'SB_STATIC_DIR', value: '/app/web' }
            { name: 'SB_TURN_HOST', value: 'turn.singing.rcnx.io' }
            { name: 'SB_TURN_SHARED_SECRET', secretRef: 'sb-turn-secret' }
            { name: 'SB_CF_WORKER_URL', secretRef: 'sb-cf-worker-url' }
            { name: 'SB_CF_WORKER_SECRET', secretRef: 'sb-cf-worker-secret' }
            { name: 'SB_SESSION_LOG_PEPPER', secretRef: 'sb-session-log-pepper' }
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
      ]
    }
  }
}

output appFqdn string = app.properties.configuration.ingress.fqdn
output appId string = app.id
