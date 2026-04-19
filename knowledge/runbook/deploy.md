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

## Monitoring

```bash
# Tail Container App logs
az containerapp logs show -n sb-server -g sb-prod-rg --follow

# List revisions
az containerapp revision list -n sb-server -g sb-prod-rg -o table
```
