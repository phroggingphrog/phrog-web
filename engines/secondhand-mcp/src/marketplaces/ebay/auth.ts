import { TokenResponse } from './wire.js';

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const OAUTH_SCOPE = 'https://api.ebay.com/oauth/api_scope';
const REFRESH_MARGIN_MS = 60_000;

/** An application token for the Browse API, fetched once and reused until near expiry. */
export class EbayToken {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string
  ) {}

  async get(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) {
      return this.accessToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=client_credentials&scope=${encodeURIComponent(OAUTH_SCOPE)}`,
    });

    if (!response.ok) {
      throw new Error(`eBay OAuth failed with status ${response.status}`);
    }

    const data = (await response.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }
}
