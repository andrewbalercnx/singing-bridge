# Runbook: Deploy

> **Single-replica constraint:** `minReplicas=maxReplicas=1` in `container-app.bicep`
> must never be changed while SQLite is the database engine. WAL file locks are
> node-local — a second replica will corrupt the database.

## One-time Bootstrap

```bash
# 1. Create resource group (UK South)
az group create --name sb-prod-rg --location uksouth

# 2. Deploy ACR
az deployment group create \
  --resource-group sb-prod-rg \
  --template-file infra/bicep/acr.bicep

# 3. Deploy Log Analytics
az deployment group create \
  --resource-group sb-prod-rg \
  --template-file infra/bicep/log-analytics.bicep

# 3.5. Deploy VNet (required before Container App Environment)
az deployment group create \
  --resource-group sb-prod-rg \
  --template-file infra/bicep/vnet.bicep

# 4. Deploy Container App (inject secrets from Key Vault / env)
#    Pass VNet subnet IDs from step 3.5 outputs.
ACA_SUBNET=$(az deployment group show -g sb-prod-rg -n vnet --query properties.outputs.acaSubnetId.value -o tsv)
STORAGE_SUBNET=$(az deployment group show -g sb-prod-rg -n vnet --query properties.outputs.storageSubnetId.value -o tsv)

az deployment group create \
  --resource-group sb-prod-rg \
  --template-file infra/bicep/container-app.bicep \
  --parameters \
    acrLoginServer=sbprodacr.azurecr.io \
    acaSubnetId="$ACA_SUBNET" \
    storageSubnetId="$STORAGE_SUBNET" \
    logWorkspaceCustomerId=<workspace-id> \
    logWorkspaceKey=<workspace-key> \
    sbTurnSharedSecret=<32-byte-secret> \
    sbCfWorkerUrl=https://mail.singing.rcnx.io \
    sbCfWorkerSecret=<32-byte-secret> \
    sbSessionLogPepper=<32-byte-secret> \
    sbSidecarSecret=<32-byte-secret> \
    sbAcsConnectionString=<acs-connection-string>

# 4.5. Deploy Backup Job
CAE_ID=$(az deployment group show -g sb-prod-rg -n container-app --query 'properties.outputs.appId.value' -o tsv | sed 's|/apps/.*||')
az deployment group create \
  --resource-group sb-prod-rg \
  --template-file infra/bicep/backup-job.bicep \
  --parameters \
    acrLoginServer=sbprodacr.azurecr.io \
    caEnvId="$CAE_ID"

# 5. Deploy coturn VM
az deployment group create \
  --resource-group sb-prod-rg \
  --template-file infra/bicep/coturn-vm.bicep \
  --parameters \
    adminSshPublicKey="$(cat ~/.ssh/id_ed25519.pub)" \
    turnSharedSecret=<same-32-byte-secret-as-above> \
    maintainerIp=<your-ip>/32 \
    adminEmail=andrew.bale@rcnx.io

# Get the coturn static IP for DNS:
az network public-ip show -n sb-turn-pip -g sb-prod-rg --query ipAddress -o tsv

# 6. Configure DNS (Wix or other registrar):
#    singing      CNAME  <container-app-fqdn>          (get from step 4 output)
#    turn.singing A      <vm-static-ip>                (get from step 5 above)
#    mail.singing CNAME  singing-bridge-mail.singing-bridge.workers.dev
#    asuid.singing TXT   <domain-verification-token>   (get from step 6a below)

# 6a. Bind TLS cert on the Container App (run after DNS propagates):
az containerapp hostname add \
  --name sb-server --resource-group sb-prod-rg \
  --hostname singing.rcnx.io
# ^ This will fail with the required TXT token value — add that as asuid.singing, then re-run:
az containerapp hostname bind \
  --name sb-server --resource-group sb-prod-rg \
  --hostname singing.rcnx.io \
  --environment sb-env \
  --validation-method CNAME

# 6b. Mint TLS cert on the coturn VM (run after turn.singing DNS propagates):
ssh azureuser@<vm-static-ip> sudo /usr/local/bin/sb-setup-tls.sh

# 7. Deploy Cloudflare Worker:
#    wrangler deploy infra/cloudflare/workers/magic-link-relay.js
#    wrangler secret put MAIL_SHARED_SECRET
#    wrangler secret put MAIL_FROM
#    wrangler secret put DKIM_SELECTOR
#    wrangler secret put DKIM_PRIVATE_KEY
#    wrangler secret put DKIM_DOMAIN
```

## Per-release Deploy (CI)

Trigger the `Deploy to Azure` workflow dispatch from GitHub Actions.
The workflow builds the image, pushes to ACR, updates the Container App,
and verifies `/healthz`.

## NFS Migration / Cutover (Sprint 16 one-time procedure)

The Container App Environment (CAE) does not support adding VNet integration
in place. This procedure replaces the old SMB-backed environment with the new
NFS-backed one, with a brief DNS cutover window (~2 minutes downtime).

```bash
# Step 1: Deploy vnet.bicep (new resource — safe to run against live system)
az deployment group create -g sb-prod-rg --template-file infra/bicep/vnet.bicep

# Step 2: Deploy NFS storage account + new CAE (runs alongside old CAE)
az deployment group create -g sb-prod-rg --template-file infra/bicep/container-app.bicep \
  --parameters acrLoginServer=sbprodacr.azurecr.io acaSubnetId=... storageSubnetId=... [all secrets]

# Step 3: Verify new app is healthy
NEW_FQDN=$(az deployment group show -g sb-prod-rg -n container-app \
  --query properties.outputs.appFqdn.value -o tsv)
curl -sf "https://$NEW_FQDN/healthz"

# Step 4: Update Cloudflare DNS CNAME from old FQDN to $NEW_FQDN
# (Cloudflare proxied record with 1-minute TTL — effective cutover < 2 min)

# Step 5: Verify singing.rcnx.io/healthz returns 200

# Step 6: Bind TLS hostname on new Container App (see step 6a above)

# Step 7: Delete old resources
az containerapp delete --name sb-server-old --resource-group sb-prod-rg --yes
az containerapp env delete --name sb-env-old --resource-group sb-prod-rg --yes
az storage account delete --name <old-smb-account> --resource-group sb-prod-rg --yes
```

## Database Backup

The application container is distroless (no shell). Backups run as a Container App Job.

```bash
# Trigger a backup (uploads to the backup storage account as a .db blob)
az containerapp job start \
  --name sb-backup-job \
  --resource-group sb-prod-rg

# Watch job logs
az containerapp job execution list \
  --name sb-backup-job \
  --resource-group sb-prod-rg \
  --query '[0].name' -o tsv | \
xargs -I{} az containerapp job execution show \
  --name sb-backup-job --resource-group sb-prod-rg --job-execution-name {}

# List backups
BACKUP_ACCOUNT=$(az deployment group show -g sb-prod-rg -n backup-job \
  --query properties.outputs.backupStorageAccountName.value -o tsv)
az storage blob list \
  --account-name "$BACKUP_ACCOUNT" \
  --container-name backups \
  --auth-mode login \
  --query '[].{name:name, size:properties.contentLength}' -o table
```

### Download and encrypt a backup

The raw `.db` file contains Argon2id password hashes, SHA-256 email hashes, and
HMAC session tokens. Encrypt before storing anywhere outside Azure.

```bash
# Add a temporary IP rule to the backup storage account network ACLs
BACKUP_ACCOUNT=<from above>
MY_IP=$(curl -s https://ifconfig.me)
az storage account network-rule add \
  --account-name "$BACKUP_ACCOUNT" --resource-group sb-prod-rg \
  --ip-address "$MY_IP"

# Wait ~30 seconds for the rule to propagate, then download
az storage blob download \
  --account-name "$BACKUP_ACCOUNT" \
  --container-name backups \
  --name <blob-name>.db \
  --file /tmp/backup.db \
  --auth-mode login

# Encrypt immediately; delete plaintext
gpg --symmetric --cipher-algo AES256 /tmp/backup.db
rm /tmp/backup.db

# Remove the temporary IP rule
az storage account network-rule remove \
  --account-name "$BACKUP_ACCOUNT" --resource-group sb-prod-rg \
  --ip-address "$MY_IP"
```

## Database Restore

Stop the app, overwrite the DB via a restore job, restart.

```bash
# 1. Scale the app to 0 replicas (stops DB writes)
az containerapp update \
  --name sb-server --resource-group sb-prod-rg \
  --min-replicas 0 --max-replicas 0

# 2. Decrypt the backup
gpg --decrypt backup.db.gpg > /tmp/restore.db

# 3. Upload restore.db to the NFS share via a one-shot Container App Job
#    (alpine image with NFS volume mount; not yet automated — use az containerapp job start
#    with a custom command override, or upload via a debug container)

# 4. Restart app
az containerapp update \
  --name sb-server --resource-group sb-prod-rg \
  --min-replicas 1 --max-replicas 1

# 5. Verify
curl -sf https://singing.rcnx.io/healthz
```

## Monitoring

```bash
# Tail Container App logs
az containerapp logs show -n sb-server -g sb-prod-rg --follow

# List revisions
az containerapp revision list -n sb-server -g sb-prod-rg -o table
```
