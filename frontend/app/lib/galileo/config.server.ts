import type { GalileoProvider } from '../stepModels';

export const GALILEO_EU_ENDPOINTS = [
  'https://eu.aigw.galileo.roche.com/v1',
  'https://waf-eu.aigw.galileo.roche.com/v1',
] as const;

export interface GalileoGatewayConfig {
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  authMode: 'bearer' | 'portkey';
  providerSlugs: Partial<Record<GalileoProvider, string>>;
  timeoutMs: number;
}

export class GalileoConfigurationError extends Error {
  readonly code = 'GATEWAY_NOT_CONFIGURED';
}

export function readGalileoConfig(environment: Record<string, string | undefined> = process.env): GalileoGatewayConfig {
  const baseUrl = (environment.PORTKEY_EU_BASE_URL || GALILEO_EU_ENDPOINTS[0]).replace(/\/+$/, '');
  const apiKey = environment.PORTKEY_EU_API_KEY?.trim();
  if (!(GALILEO_EU_ENDPOINTS as readonly string[]).includes(baseUrl)) {
    throw new GalileoConfigurationError('PORTKEY_EU_BASE_URL must be a documented Galileo EU RCN or WAF endpoint.');
  }
  if (!apiKey || /[\r\n]/.test(apiKey)) {
    throw new GalileoConfigurationError('Configure PORTKEY_EU_API_KEY in the server environment.');
  }
  const authMode = environment.PORTKEY_EU_AUTH_MODE || 'bearer';
  if (authMode !== 'bearer' && authMode !== 'portkey') {
    throw new GalileoConfigurationError('PORTKEY_EU_AUTH_MODE must be bearer or portkey.');
  }
  const providerSlugs: Partial<Record<GalileoProvider, string>> = {};
  for (const [provider, variable] of [
    ['openai', 'PORTKEY_EU_OPENAI_PROVIDER'],
    ['bedrock', 'PORTKEY_EU_BEDROCK_PROVIDER'],
    ['azure-openai', 'PORTKEY_EU_AZURE_PROVIDER'],
  ] as const) {
    const slug = environment[variable]?.trim();
    if (!slug) continue;
    if (!/^@[a-zA-Z0-9_-]{1,100}$/.test(slug)) {
      throw new GalileoConfigurationError(`${variable} must be a Portkey provider slug starting with @.`);
    }
    providerSlugs[provider] = slug;
  }
  const timeoutMs = Number(environment.PORTKEY_EU_TIMEOUT_MS || 120000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) {
    throw new GalileoConfigurationError('PORTKEY_EU_TIMEOUT_MS must be between 1000 and 3600000.');
  }
  return {
    baseUrl,
    apiKey,
    enabled: environment.GALILEO_ENABLED === 'true',
    authMode,
    providerSlugs,
    timeoutMs,
  };
}