import { GoogleGenAI, type GoogleGenAIOptions } from "@google/genai";

import { getRuntimeSingleton } from "../utils/runtimeSingleton.js";
import { getGoogleAuthOptions, getGoogleServiceAccount } from "./auth.js";

export const GEMINI_TEXT_MODEL_IDS = [
  "gemini-3.1-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
] as const;

export const GEMINI_IMAGE_MODEL_IDS = [
  "gemini-3-pro-image-preview",
  "gemini-3.1-flash-image-preview",
] as const;

export const GEMINI_MODEL_IDS = [...GEMINI_TEXT_MODEL_IDS, ...GEMINI_IMAGE_MODEL_IDS] as const;

export type GeminiModelId = (typeof GEMINI_MODEL_IDS)[number];
export type GeminiTextModelId = (typeof GEMINI_TEXT_MODEL_IDS)[number];
export type GeminiImageModelId = (typeof GEMINI_IMAGE_MODEL_IDS)[number];

export function isGeminiModelId(value: string): value is GeminiModelId {
  return (GEMINI_MODEL_IDS as readonly string[]).includes(value);
}

export function isGeminiTextModelId(value: string): value is GeminiTextModelId {
  return (GEMINI_TEXT_MODEL_IDS as readonly string[]).includes(value);
}

export function isGeminiImageModelId(value: string): value is GeminiImageModelId {
  return (GEMINI_IMAGE_MODEL_IDS as readonly string[]).includes(value);
}

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const DEFAULT_VERTEX_LOCATION = "global";

export type GeminiConfiguration = {
  readonly projectId?: string;
  readonly location?: string;
};

const geminiClientState = getRuntimeSingleton(Symbol.for("@ljoukov/llm.geminiClientState"), () => ({
  geminiConfiguration: {} as GeminiConfiguration,
  clientPromise: undefined as Promise<GoogleGenAI> | undefined,
}));

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
  geminiClientState.geminiConfiguration = {
    projectId:
      nextProjectId !== undefined ? nextProjectId : geminiClientState.geminiConfiguration.projectId,
    location:
      nextLocation !== undefined ? nextLocation : geminiClientState.geminiConfiguration.location,
  };
  geminiClientState.clientPromise = undefined;
}

function resolveProjectId(): string {
  const override = geminiClientState.geminiConfiguration.projectId;
  if (override) {
    return override;
  }
  const serviceAccount = getGoogleServiceAccount();
  return serviceAccount.projectId;
}

function resolveLocation(): string {
  const override = geminiClientState.geminiConfiguration.location;
  if (override) {
    return override;
  }
  return DEFAULT_VERTEX_LOCATION;
}

export async function getGeminiClient(): Promise<GoogleGenAI> {
  if (!geminiClientState.clientPromise) {
    geminiClientState.clientPromise = Promise.resolve().then(() => {
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
  return geminiClientState.clientPromise;
}
