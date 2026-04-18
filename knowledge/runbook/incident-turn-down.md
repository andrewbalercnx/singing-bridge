# Runbook: TURN Server Down

## Symptoms

- Students fail to connect (WebRTC ICE failure).
- Floor-violation spike on teacher side (audio drops immediately).
- Browser console: `ICE failed` or `RTCPeerConnection state: failed`.

## Diagnosis

```bash
# SSH to the TURN VM (maintainer IP required)
ssh azureuser@turn.singing.rcnx.io

# Check coturn status
sudo systemctl status coturn

# Check logs
sudo tail -100 /var/log/turnserver.log

# Check TLS cert expiry
sudo certbot certificates | grep "Expiry Date"
```

## Remediation

### coturn crashed / stopped

```bash
sudo systemctl restart coturn
sudo systemctl status coturn
```

### TLS cert expired (3-month cadence)

```bash
# Stop coturn temporarily (certbot standalone needs port 80/443)
sudo systemctl stop coturn
sudo certbot certonly --standalone -d turn.singing.rcnx.io
sudo systemctl start coturn
```

### VM unreachable

Check the Azure NSG — ensure 3478/udp, 3478/tcp, 5349/tcp are open.
Check the Azure public IP is still assigned to the VM NIC.

```bash
az network public-ip show -n sb-turn-pip -g sb-prod-rg --query "ipAddress"
```

## Fallback

There is no hot standby TURN server. While TURN is down:
- Clients behind symmetric NAT will fail to connect.
- Clients that can reach each other directly (same network, or
  non-symmetric NAT) may still connect via STUN.
- The server code falls back to `stun.l.google.com` on credential
  fetch failure — this leaks public IPs to Google but keeps calls
  working for non-symmetric NAT users.

Target resolution: < 30 minutes for cert renewal, < 10 minutes for
service restart.
