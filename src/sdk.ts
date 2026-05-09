/**
 * Lazy JecpClient construction — uses resolveAuth() for credentials.
 */

import { JecpClient } from '@jecpdev/sdk';
import { resolveAuth } from './config.js';
import { fail } from './output.js';

export function getClient(): JecpClient {
  const { agentId, apiKey, baseUrl } = resolveAuth();
  if (!agentId || !apiKey) {
    fail('Not logged in. Run `jecp login` or `jecp register`.');
  }
  return new JecpClient({
    agentId: agentId!,
    apiKey: apiKey!,
    ...(baseUrl && { baseUrl }),
  });
}

export function getBaseUrl(): string {
  return resolveAuth().baseUrl ?? 'https://jecp.dev';
}
