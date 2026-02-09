import { GoogleAuth, type AnyAuthClient, type GoogleAuthOptions } from "google-auth-library";
import { z } from "zod";

import { loadLocalEnv } from "../utils/env.js";

export type GoogleServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  tokenUri?: string;
};

const ServiceAccountSchema = z
  .object({
    project_id: z.string().min(1),
    client_email: z.email(),
    private_key: z.string().min(1),
    token_uri: z.string().optional(),
  })
  .transform(({ project_id, client_email, private_key, token_uri }) => ({
    projectId: project_id,
    clientEmail: client_email,
    privateKey: private_key.replace(/\\n/g, "\n"),
    tokenUri: token_uri,
  }));

let cachedServiceAccount: GoogleServiceAccount | null = null;
const authClientCache = new Map<string, GoogleAuth<AnyAuthClient>>();

export function parseGoogleServiceAccount(input: string): GoogleServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new Error(`Invalid Google service account JSON: ${(error as Error).message}`);
  }
  return ServiceAccountSchema.parse(parsed);
}

export function getGoogleServiceAccount(): GoogleServiceAccount {
  if (cachedServiceAccount) {
    return cachedServiceAccount;
  }

  loadLocalEnv();

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || raw.trim().length === 0) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON must be provided for Google APIs access.");
  }

  cachedServiceAccount = parseGoogleServiceAccount(raw);
  return cachedServiceAccount;
}

function normaliseScopes(scopes?: string | readonly string[]): string[] | undefined {
  if (!scopes) {
    return undefined;
  }
  if (typeof scopes === "string") {
    return [scopes];
  }
  if (scopes.length === 0) {
    return undefined;
  }
  return Array.from(new Set(scopes)).sort();
}

export function getGoogleAuthOptions(
  scopes?: string | readonly string[],
): GoogleAuthOptions<AnyAuthClient> {
  const serviceAccount = getGoogleServiceAccount();
  const normalisedScopes = normaliseScopes(scopes);
  const options: GoogleAuthOptions<AnyAuthClient> = {
    credentials: {
      client_email: serviceAccount.clientEmail,
      private_key: serviceAccount.privateKey,
    },
    projectId: serviceAccount.projectId,
    scopes: normalisedScopes,
  };
  return options;
}

export function getGoogleAuth(scopes?: string | readonly string[]): GoogleAuth<AnyAuthClient> {
  const normalised = normaliseScopes(scopes);
  const key = (normalised ?? []).join(" ");
  const cached = authClientCache.get(key);
  if (cached) {
    return cached;
  }
  const auth = new GoogleAuth(getGoogleAuthOptions(normalised));
  authClientCache.set(key, auth);
  return auth;
}

export async function getGoogleAccessToken(scopes?: string | readonly string[]): Promise<string> {
  const auth = getGoogleAuth(scopes);
  const token = await auth.getAccessToken();
  if (!token) {
    throw new Error("GoogleAuth returned an empty access token.");
  }
  return token;
}
