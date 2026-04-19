// File: infra/bicep/coturn-vm.bicep
// Purpose: Azure VM running coturn with static public IP. Minimal B1s SKU.
// Role: TURN server for WebRTC NAT traversal. Cannot be proxied through CF.
//       Its DNS record is grey-cloud (DNS-only) pointing at the static IP.
// Invariants: SSH access restricted to maintainer IP only. NSG allows
//             3478/udp + 3478/tcp + 5349/tcp from any. coturn config is
//             0600 owned by turnserver:turnserver (SSRF protection via
//             denied-peer-ip rules for RFC-1918, link-local, IMDS, etc.).
// Last updated: Sprint 5 (2026-04-18) -- initial implementation

param location string = resourceGroup().location
param vmName string = 'sb-turn'
param adminUsername string = 'azureuser'
@secure()
param adminSshPublicKey string
@secure()
param turnSharedSecret string
param maintainerIp string  // SSH allow-list; restrict to VPN/home IP
param adminEmail string    // Let's Encrypt account email for certbot

var vmSize = 'Standard_D2als_v7'

// ---- Static public IP ----
resource publicIp 'Microsoft.Network/publicIPAddresses@2023-04-01' = {
  name: '${vmName}-pip'
  location: location
  sku: { name: 'Standard' }
  properties: {
    publicIPAllocationMethod: 'Static'
    dnsSettings: { domainNameLabel: 'sb-turn-${uniqueString(resourceGroup().id)}' }
  }
}

// ---- NSG ----
resource nsg 'Microsoft.Network/networkSecurityGroups@2023-04-01' = {
  name: '${vmName}-nsg'
  location: location
  properties: {
    securityRules: [
      {
        name: 'AllowSshFromMaintainer'
        properties: {
          priority: 100
          protocol: 'Tcp'
          access: 'Allow'
          direction: 'Inbound'
          sourceAddressPrefix: maintainerIp
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '22'
        }
      }
      {
        name: 'AllowTurnUdp'
        properties: {
          priority: 200
          protocol: 'Udp'
          access: 'Allow'
          direction: 'Inbound'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '3478'
        }
      }
      {
        name: 'AllowTurnTcp'
        properties: {
          priority: 210
          protocol: 'Tcp'
          access: 'Allow'
          direction: 'Inbound'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '3478'
        }
      }
      {
        name: 'AllowTurnsTcp'
        properties: {
          priority: 220
          protocol: 'Tcp'
          access: 'Allow'
          direction: 'Inbound'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '5349'
        }
      }
      {
        name: 'AllowHttp80'
        properties: {
          priority: 150
          protocol: 'Tcp'
          access: 'Allow'
          direction: 'Inbound'
          sourceAddressPrefix: '*'
          sourcePortRange: '*'
          destinationAddressPrefix: '*'
          destinationPortRange: '80'
        }
      }
    ]
  }
}

// ---- VNet + Subnet ----
resource vnet 'Microsoft.Network/virtualNetworks@2023-04-01' = {
  name: '${vmName}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.0.0.0/24'] }
    subnets: [
      { name: 'default', properties: { addressPrefix: '10.0.0.0/24', networkSecurityGroup: { id: nsg.id } } }
    ]
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2023-04-01' = {
  name: '${vmName}-nic'
  location: location
  properties: {
    ipConfigurations: [
      {
        name: 'ipconfig1'
        properties: {
          subnet: { id: '${vnet.id}/subnets/default' }
          publicIPAddress: { id: publicIp.id }
          privateIPAllocationMethod: 'Dynamic'
        }
      }
    ]
  }
}

// Cloud-init with coturn config. TURN secret injected via Bicep replace()
// because raw triple-quoted strings cannot interpolate variables.
//
// TLS bootstrapping: certbot cannot run at first boot because the DNS A record
// does not exist until after the VM's static IP is known (deploy step 5 → step 6).
// Instead, cloud-init installs /usr/local/bin/sb-setup-tls.sh. After the DNS A
// record propagates, the operator runs that script once (see deploy runbook step 6a).
// Subsequent renewals are handled automatically by the certbot deploy hook.
var cloudInitTemplate = '''
#cloud-config
package_update: true
packages:
  - coturn
  - ufw
  - certbot
write_files:
  - path: /etc/turnserver.conf
    owner: turnserver:turnserver
    permissions: '0600'
    content: |
      listening-port=3478
      tls-listening-port=5349
      realm=singing.rcnx.io
      use-auth-secret
      static-auth-secret=TURN_SECRET_PLACEHOLDER
      total-quota=100
      user-quota=12
      stale-nonce=600
      no-multicast-peers
      no-loopback-peers
      no-tlsv1
      no-tlsv1_1
      denied-peer-ip=10.0.0.0-10.255.255.255
      denied-peer-ip=172.16.0.0-172.31.255.255
      denied-peer-ip=192.168.0.0-192.168.255.255
      denied-peer-ip=169.254.0.0-169.254.255.255
      denied-peer-ip=127.0.0.0-127.255.255.255
      denied-peer-ip=100.64.0.0-100.127.255.255
      denied-peer-ip=::1
      denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
      denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
      log-file=/var/log/turnserver.log
      simple-log
      cert=/etc/coturn/certs/fullchain.pem
      pkey=/etc/coturn/certs/privkey.pem
  - path: /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      set -e
      cp /etc/letsencrypt/live/turn.singing.rcnx.io/fullchain.pem /etc/coturn/certs/fullchain.pem
      cp /etc/letsencrypt/live/turn.singing.rcnx.io/privkey.pem   /etc/coturn/certs/privkey.pem
      chown turnserver:turnserver /etc/coturn/certs/*.pem
      chmod 644 /etc/coturn/certs/fullchain.pem
      chmod 600 /etc/coturn/certs/privkey.pem
      systemctl restart coturn
  - path: /usr/local/bin/sb-setup-tls.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      # Run once after the DNS A record for turn.singing.rcnx.io has propagated.
      set -e
      certbot certonly --standalone --non-interactive --agree-tos \
        --email ADMIN_EMAIL_PLACEHOLDER \
        -d turn.singing.rcnx.io
      /etc/letsencrypt/renewal-hooks/deploy/coturn.sh
      echo "TLS setup complete. Verifying port 5349..."
      ss -tlnp | grep 5349
runcmd:
  - mkdir -p /etc/coturn/certs
  - chown turnserver:turnserver /etc/coturn/certs
  - touch /var/log/turnserver.log
  - chown turnserver:turnserver /var/log/turnserver.log
  - ufw allow 22/tcp
  - ufw allow 80/tcp
  - ufw allow 3478
  - ufw allow 3478/udp
  - ufw allow 5349/tcp
  - ufw --force enable
  - systemctl enable --now coturn
'''

var cloudInit = base64(replace(replace(cloudInitTemplate, 'TURN_SECRET_PLACEHOLDER', turnSharedSecret), 'ADMIN_EMAIL_PLACEHOLDER', adminEmail))

// ---- VM ----
resource vm 'Microsoft.Compute/virtualMachines@2023-03-01' = {
  name: vmName
  location: location
  properties: {
    hardwareProfile: { vmSize: vmSize }
    osProfile: {
      computerName: vmName
      adminUsername: adminUsername
      customData: cloudInit
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: { publicKeys: [{ path: '/home/${adminUsername}/.ssh/authorized_keys', keyData: adminSshPublicKey }] }
      }
    }
    storageProfile: {
      imageReference: {
        publisher: 'Canonical'
        offer: '0001-com-ubuntu-server-jammy'
        sku: '22_04-lts-gen2'
        version: 'latest'
      }
      osDisk: { createOption: 'FromImage', managedDisk: { storageAccountType: 'Standard_LRS' } }
    }
    networkProfile: { networkInterfaces: [{ id: nic.id }] }
  }
}

output turnPublicIp string = publicIp.properties.ipAddress
output turnVmId string = vm.id
