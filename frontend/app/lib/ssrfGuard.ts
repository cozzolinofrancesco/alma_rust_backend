
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { Agent } from 'undici';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
]);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  const inRange = (cidrBase: string, bits: number) => {
    const base = ipv4ToInt(cidrBase);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (base & mask);
  };
  return (
    inRange('0.0.0.0', 8) ||
    inRange('10.0.0.0', 8) ||
    inRange('100.64.0.0', 10) ||
    inRange('127.0.0.0', 8) ||
    inRange('169.254.0.0', 16) ||
    inRange('172.16.0.0', 12) ||
    inRange('192.0.0.0', 24) ||
    inRange('192.168.0.0', 16) ||
    inRange('198.18.0.0', 15) ||
    inRange('224.0.0.0', 4) ||
    inRange('240.0.0.0', 4)
  );
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase().split('%')[0];
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80')) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  const mapped = lower.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped && isPrivateIpv4(mapped[1])) return true;
  return false;
}

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return true;
}

export interface ValidatedUrl {
  /** The syntactically-validated request URL (hostname preserved for SNI/Host). */
  url: URL;
  /** The public IP address(es) the host resolved to at validation time. */
  addresses: string[];
}

export async function assertPublicHttpUrl(rawUrl: string): Promise<ValidatedUrl> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (url.protocol !== 'https:') {
    throw new Error('Only https URLs are allowed');
  }

  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error('URL host is not allowed');
  }

  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error('URL host is not allowed');
    }
    return { url, addresses: [hostname] };
  }

  let results: { address: string }[];
  try {
    results = await lookup(hostname, { all: true });
  } catch {
    throw new Error('Could not resolve URL host');
  }

  if (results.length === 0 || results.some((r) => isPrivateAddress(r.address))) {
    throw new Error('URL host is not allowed');
  }

  return { url, addresses: results.map((r) => r.address) };
}

/**
 * Build an undici dispatcher that connects only to the given, already-validated
 * public IP address(es). Passing this to `fetch` pins the socket to the address
 * vetted by {@link assertPublicHttpUrl} (the original hostname/SNI is preserved),
 * closing the DNS-rebind TOCTOU window in which the name could re-resolve to a
 * private IP between validation and the request (FE-SSRF-002). Addresses are
 * re-checked here as defense in depth.
 */
export function pinnedHttpsDispatcher(addresses: string[]): Agent {
  const safeAddresses = addresses.filter((address) => !isPrivateAddress(address));
  // Signature matches `net.connect`'s `lookup` option; handle both the single
  // and `all: true` (autoSelectFamily) callback conventions Node may use.
  const lookupPinned: net.LookupFunction = (_hostname, options, callback) => {
    if (safeAddresses.length === 0) {
      callback(new Error('URL host is not allowed') as NodeJS.ErrnoException, '', 0);
      return;
    }
    if (options.all) {
      callback(
        null,
        safeAddresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 })),
      );
      return;
    }
    const address = safeAddresses[0];
    callback(null, address, net.isIPv6(address) ? 6 : 4);
  };
  // `connect.lookup` lives only on undici's TcpNetConnectOpts branch (which also
  // marks `port` required), so a bare `{ lookup }` literal doesn't line up with the
  // BuildOptions union — cast to the constructor's option type at this one seam.
  return new Agent({ connect: { lookup: lookupPinned } } as unknown as Agent.Options);
}
