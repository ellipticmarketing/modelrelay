import { networkInterfaces } from 'node:os'

function isPrivateIpv4(ip) {
  if (!ip) return false

  if (ip.startsWith('10.')) return true
  if (ip.startsWith('192.168.')) return true

  if (ip.startsWith('172.')) {
    const secondOctet = Number(ip.split('.')[1])
    return secondOctet >= 16 && secondOctet <= 31
  }

  return false
}

export function getLocalIpv4Addresses() {
  const interfaces = networkInterfaces()
  const addresses = []

  for (const entries of Object.values(interfaces)) {
    if (!entries) continue

    for (const entry of entries) {
      const isIpv4 = entry.family === 'IPv4' || entry.family === 4
      if (!isIpv4 || entry.internal || !entry.address) continue
      addresses.push(entry.address)
    }
  }

  return [...new Set(addresses)]
}

export function getPreferredLanIpv4Address() {
  const addresses = getLocalIpv4Addresses()
  const privateAddress = addresses.find(isPrivateIpv4)
  return privateAddress || addresses[0] || null
}
