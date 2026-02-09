import { GoogleGenAI, type GoogleGenAIOptions } from "@google/genai";

import { getGoogleAuthOptions, getGoogleServiceAccount } from "./auth.js";

export const GEMINI_MODEL_IDS = [
  "gemini-3-pro-preview",
  "gemini-2.5-pro",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
] as const;

export type GeminiModelId = (typeof GEMINI_MODEL_IDS)[number];

export function isGeminiModelId(value: string): value is GeminiModelId {
  return (GEMINI_MODEL_IDS as readonly string[]).includes(value);
}

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_VERTEX_LOCATION = "global";

export type GeminiConfiguration = {
  readonly projectId?: string;
  readonly location?: string;
};

let geminiConfiguration: GeminiConfiguration = {};
let clientPromise: Promise<GoogleGenAI> | undefined;

function normaliseConfigValue(value?: string | null): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function configureGemini(options: GeminiConfiguration = {}): void {
  const nextProjectId = normaliseConfigValue(options.projectId);
  const nextLocation = normaliseConfigValue(options.location);
  geminiConfiguration = {
    projectId: nextProjectId !== undefined ? nextProjectId : geminiConfiguration.projectId,
    location: nextLocation !== undefined ? nextLocation : geminiConfiguration.location,
  };
  clientPromise = undefined;
}

function resolveProjectId(): string {
  const override = geminiConfiguration.projectId;
  if (override) {
    return override;
  }
  const serviceAccount = getGoogleServiceAccount();
  return serviceAccount.projectId;
}

function resolveLocation(): string {
  const override = geminiConfiguration.location;
  if (override) {
    return override;
  }
  return DEFAULT_VERTEX_LOCATION;
}

export async function getGeminiClient(): Promise<GoogleGenAI> {
  if (!clientPromise) {
    clientPromise = Promise.resolve().then(() => {
      const projectId = resolveProjectId();
      const location = resolveLocation();
      const googleAuthOptions = getGoogleAuthOptions(CLOUD_PLATFORM_SCOPE);
      return new GoogleGenAI({
        vertexai: true,
        project: projectId,
        location,
        googleAuthOptions: googleAuthOptions as GoogleGenAIOptions["googleAuthOptions"],
      });
    });
  }
  return clientPromise;
}
