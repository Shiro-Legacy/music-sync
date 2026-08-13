import os from 'node:os';
import qrcode from 'qrcode-terminal';
import type { QrPayload } from '@music-sync/shared';
import type { ServerConfig } from './config.js';

/** Non-internal IPv4 addresses of this machine, i.e. where LAN clients can reach us. */
export function lanIpv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address);
    }
  }
  return addresses;
}

/** Token in groups of 4 for manual entry on the phone. */
export function formatTokenForEntry(token: string): string {
  return token.match(/.{1,4}/g)?.join(' ') ?? token;
}

export function printPairing(config: ServerConfig): void {
  const addresses = lanIpv4Addresses();
  console.log('');
  console.log('=== Pair your iPhone ===');
  if (addresses.length === 0) {
    console.log('No LAN IPv4 address found — connect this machine to your network, then run --pair again.');
  } else {
    console.log('Server addresses:');
    for (const address of addresses) {
      console.log(`  http://${address}:${config.port}`);
    }
    const host = addresses[0];
    if (host !== undefined) {
      const payload: QrPayload = {
        v: 1,
        host,
        port: config.port,
        token: config.token,
        name: config.name,
      };
      console.log('');
      console.log('Scan this QR code in the app:');
      qrcode.generate(JSON.stringify(payload), { small: true });
    }
  }
  console.log(`Manual pairing token: ${formatTokenForEntry(config.token)}`);
  console.log('');
}
