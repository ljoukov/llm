import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./index.js";

const keys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {
  timeoutDuration: 5000,
  cacheMaxAge: 60 * 60 * 1000,
});

export function isAllowedAdminEmail(env: Env, email: string): boolean {
  const allowed = (env.ADMIN_ALLOWED_EMAILS ?? "")
    .split(/[\s,;]+/u)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.trim().toLowerCase());
}

export async function verifyGoogleIdentity(
  env: Env,
  credential: string,
): Promise<{ subject: string; email: string; nonce: string }> {
  const audience = env.ADMIN_GOOGLE_CLIENT_ID?.trim();
  if (!audience) throw new Error("Google sign-in is not configured.");
  const { payload } = await jwtVerify(credential, keys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience,
    algorithms: ["RS256"],
    maxTokenAge: "10m",
    clockTolerance: 30,
    requiredClaims: ["sub", "email", "email_verified", "nonce", "iat", "exp"],
  });
  if (
    payload.email_verified !== true ||
    typeof payload.email !== "string" ||
    typeof payload.nonce !== "string" ||
    !payload.sub ||
    payload.sub.length > 255
  ) {
    throw new Error("Invalid Google identity.");
  }
  return { subject: payload.sub, email: payload.email.trim().toLowerCase(), nonce: payload.nonce };
}
