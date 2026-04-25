// File: infra/bicep/container-app.bicep
// Purpose: Container Apps environment + singing-bridge app + OMR sidecar.
// Role: Hosts the single-replica server backed by Azure Database for PostgreSQL.
// Invariants: CF IP allow-list codified in ipSecurityRestrictions (not a runbook step).
//             Ingress restricted to Cloudflare published IP ranges only.
//             SB_DATABASE_URL wired via Key Vault reference (sbapp credential).
// Last updated: Sprint 19 (2026-04-25) -- remove NFS storage; PostgreSQL via SB_DATABASE_URL

param location string = resourceGroup().location
param environmentName string = 'sb-env'
param appName string = 'sb-server'
param acrLoginServer string
param imageName string = 'singing-bridge:latest'
param sidecarImageName string = 'singing-bridge-sidecar:latest'
param logWorkspaceCustomerId string
@secure()
param logWorkspaceKey string

// Shared Key Vault URI for KV-reference secrets (non-secret; just the vault URI).
param sharedKvUri string = 'https://rcnx-shared-kv.vault.azure.net/'

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

// ---- Container Apps Environment ----
resource caEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
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

// ---- Container App ----
resource app 'Microsoft.App/containerApps@2024-03-01' = {
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
        ipSecurityRestrictions: [
          // Cloudflare IPv4 ranges — allow-list maintained here, not as a runbook step.
          { name: 'cf-1',  action: 'Allow', ipAddressRange: '173.245.48.0/20'  }
          { name: 'cf-2',  action: 'Allow', ipAddressRange: '103.21.244.0/22'  }
          { name: 'cf-3',  action: 'Allow', ipAddressRange: '103.22.200.0/22'  }
          { name: 'cf-4',  action: 'Allow', ipAddressRange: '103.31.4.0/22'    }
          { name: 'cf-5',  action: 'Allow', ipAddressRange: '141.101.64.0/18'  }
          { name: 'cf-6',  action: 'Allow', ipAddressRange: '108.162.192.0/18' }
          { name: 'cf-7',  action: 'Allow', ipAddressRange: '190.93.240.0/20'  }
          { name: 'cf-8',  action: 'Allow', ipAddressRange: '188.114.96.0/20'  }
          { name: 'cf-9',  action: 'Allow', ipAddressRange: '197.234.240.0/22' }
          { name: 'cf-10', action: 'Allow', ipAddressRange: '198.41.128.0/17'  }
          { name: 'cf-11', action: 'Allow', ipAddressRange: '162.158.0.0/15'   }
          { name: 'cf-12', action: 'Allow', ipAddressRange: '104.16.0.0/13'    }
          { name: 'cf-13', action: 'Allow', ipAddressRange: '104.24.0.0/14'    }
          { name: 'cf-14', action: 'Allow', ipAddressRange: '172.64.0.0/13'    }
          { name: 'cf-15', action: 'Allow', ipAddressRange: '131.0.72.0/22'    }
        ]
      }
      secrets: [
        { name: 'sb-turn-secret', value: sbTurnSharedSecret }
        { name: 'sb-cf-worker-url', value: sbCfWorkerUrl }
        { name: 'sb-cf-worker-secret', value: sbCfWorkerSecret }
        { name: 'sb-session-log-pepper', value: sbSessionLogPepper }
        { name: 'sb-sidecar-secret', value: sbSidecarSecret }
        { name: 'sb-acs-connection-string', value: sbAcsConnectionString }
        // KV-reference secret: raw value never stored in deployment history.
        // Requires Key Vault Secrets User RBAC on this secret for the system-assigned identity.
        { name: 'sb-db-url', keyVaultUrl: '${sharedKvUri}secrets/sb-database-url', identity: 'system' }
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
      containers: [
        {
          name: 'server'
          image: '${acrLoginServer}/${imageName}'
          env: [
            { name: 'SB_ENV', value: 'prod' }
            { name: 'SB_BASE_URL', value: 'https://singing.rcnx.io' }
            { name: 'SB_STATIC_DIR', value: '/app/web' }
            { name: 'SB_TURN_HOST', value: 'turn.singing.rcnx.io' }
            { name: 'SB_TURN_SHARED_SECRET', secretRef: 'sb-turn-secret' }
            { name: 'SB_CF_WORKER_URL', secretRef: 'sb-cf-worker-url' }
            { name: 'SB_CF_WORKER_SECRET', secretRef: 'sb-cf-worker-secret' }
            { name: 'SB_SESSION_LOG_PEPPER', secretRef: 'sb-session-log-pepper' }
            { name: 'SIDECAR_URL', value: 'http://localhost:5050' }
            { name: 'SIDECAR_SECRET', secretRef: 'sb-sidecar-secret' }
            { name: 'SB_ACS_CONNECTION_STRING', secretRef: 'sb-acs-connection-string' }
            { name: 'SB_DATABASE_URL', secretRef: 'sb-db-url' }
          ]
          resources: { cpu: json('0.5'), memory: '1Gi' }
          securityContext: {
            runAsNonRoot: true
            runAsUser: 65532
          }
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
