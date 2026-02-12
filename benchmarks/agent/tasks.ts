export type MicroTask = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly language: "ts";
  readonly source: string;
  readonly expected: string;
};

export const MICRO_TASKS: readonly MicroTask[] = [
  {
    id: "off-by-one-loop",
    title: "Off-by-one in loop guard",
    description: "The loop should stop before nums.length, not at nums.length.",
    language: "ts",
    source: [
      "export function sum(nums: number[]): number {",
      "  let total = 0;",
      "  for (let i = 0; i <= nums.length; i += 1) {",
      "    total += nums[i] ?? 0;",
      "  }",
      "  return total;",
      "}",
    ].join("\n"),
    expected: [
      "export function sum(nums: number[]): number {",
      "  let total = 0;",
      "  for (let i = 0; i < nums.length; i += 1) {",
      "    total += nums[i] ?? 0;",
      "  }",
      "  return total;",
      "}",
    ].join("\n"),
  },
  {
    id: "comparison-swap",
    title: "Comparison operator swap",
    description: "isReady should return true only for the ready status.",
    language: "ts",
    source: [
      'export function isReady(status: "draft" | "ready"): boolean {',
      '  return status !== "ready";',
      "}",
    ].join("\n"),
    expected: [
      'export function isReady(status: "draft" | "ready"): boolean {',
      '  return status === "ready";',
      "}",
    ].join("\n"),
  },
  {
    id: "nullish-vs-or",
    title: "Nullish operator fix",
    description: "Preserve explicit zero values; only fall back on null/undefined.",
    language: "ts",
    source: [
      "const DEFAULT_TIMEOUT_MS = 5000;",
      "",
      "export function getTimeout(userTimeout?: number): number {",
      "  return userTimeout || DEFAULT_TIMEOUT_MS;",
      "}",
    ].join("\n"),
    expected: [
      "const DEFAULT_TIMEOUT_MS = 5000;",
      "",
      "export function getTimeout(userTimeout?: number): number {",
      "  return userTimeout ?? DEFAULT_TIMEOUT_MS;",
      "}",
    ].join("\n"),
  },
  {
    id: "logical-op",
    title: "Logical operator fix",
    description: "Deny access when either prerequisite is missing.",
    language: "ts",
    source: [
      "export function canAccessDashboard(isAdmin: boolean, has2fa: boolean): boolean {",
      "  if (!isAdmin && !has2fa) {",
      "    return false;",
      "  }",
      "  return true;",
      "}",
    ].join("\n"),
    expected: [
      "export function canAccessDashboard(isAdmin: boolean, has2fa: boolean): boolean {",
      "  if (!isAdmin || !has2fa) {",
      "    return false;",
      "  }",
      "  return true;",
      "}",
    ].join("\n"),
  },
  {
    id: "inc-dec-swap",
    title: "Increment/decrement swap",
    description: "advanceCursor should move forward, not backward.",
    language: "ts",
    source: [
      "export function advanceCursor(cursor: number, max: number): number {",
      "  if (cursor < max) {",
      "    cursor--;",
      "  }",
      "  return cursor;",
      "}",
    ].join("\n"),
    expected: [
      "export function advanceCursor(cursor: number, max: number): number {",
      "  if (cursor < max) {",
      "    cursor++;",
      "  }",
      "  return cursor;",
      "}",
    ].join("\n"),
  },
  {
    id: "optional-chain",
    title: "Optional chain restoration",
    description: "user and profile are optional and must be safely dereferenced.",
    language: "ts",
    source: [
      "type User = { profile?: { city?: string } };",
      "",
      "export function readCity(user?: User): string {",
      '  return user.profile.city ?? "unknown";',
      "}",
    ].join("\n"),
    expected: [
      "type User = { profile?: { city?: string } };",
      "",
      "export function readCity(user?: User): string {",
      '  return user?.profile?.city ?? "unknown";',
      "}",
    ].join("\n"),
  },
];
