import { getAllMarketplaces } from '../marketplaces/index.js';
import { ToolResult, textResult } from './results.js';

export async function listMarketplaces(): Promise<ToolResult> {
  const lines = getAllMarketplaces().map(
    (mp) => `• ${mp.displayName} (${mp.name}) - ${mp.requiresAuth ? 'Requires auth' : 'No auth required'}`
  );
  return textResult(`Available Marketplaces:\n\n${lines.join('\n')}`);
}
