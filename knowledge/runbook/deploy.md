# Runbook: Deploy

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

# 4. Deploy Container App (inject secrets from Key Vault / env)
az deployment group create \
  --resource-group sb-prod-rg \
  --template-file infra/bicep/container-app.bicep \
  --parameters \
    acrLoginServer=sbprodacr.azurecr.io \
    logWorkspaceCustomerId=<workspace-id> \
    logWorkspaceKey=<workspace-key> \
    sbTurnSharedSecret=<32-byte-secret> \
    sbCfWorkerUrl=https://mail.singing.rcnx.io \
    sbCfWorkerSecret=<32-byte-secret> \
    sbSessionLogPepper=<32-byte-secret>

# 5. Deploy coturn VM
az deployment group create \
  --resource-group sb-prod-rg \
  --template-file infra/bicep/coturn-vm.bicep \
  --parameters \
    adminSshPublicKey="$(cat ~/.ssh/id_ed25519.pub)" \
    turnSharedSecret=<same-32-byte-secret-as-above> \
    maintainerIp=<your-ip>/32

# 6. Configure DNS (Cloudflare dashboard or Terraform):
#    singing.rcnx.io     A  <container-app-fqdn>   proxied (orange)
#    turn.singing.rcnx.io A  <vm-static-ip>        DNS-only (grey)

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

## Cloudflare IP Range Refresh

CF publishes updated IP ranges at https://www.cloudflare.com/ips-v4.
When ranges change, update `cfIpRanges` in `infra/bicep/container-app.bicep`
and re-deploy the Container App.

## Monitoring

```bash
# Tail Container App logs
az containerapp logs show -n sb-server -g sb-prod-rg --follow

# List revisions
az containerapp revision list -n sb-server -g sb-prod-rg -o table
```
