import { z } from "zod";
import { badRequest } from "./security/errors.js";

// ---------------------------------------------------------------------------
// Import de session Leboncoin — cookies + localStorage/JWT + User-Agent.
// Aucun mot de passe. Le bundle est validé, chiffré DPAPI, jamais réaffiché.
// ---------------------------------------------------------------------------

export const SessionImportSchema = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("manual"),
    luat: z.string().min(20, "Cookie luat requis (JWT)"),
    userId: z.string().min(1, "lbc_user_id requis"),
    userAgent: z.string().min(10, "User-Agent requis"),
    extraCookies: z.record(z.string()).optional(),
  }),
  z.object({
    format: z.literal("cookie-editor"),
    json: z.string(),
    userAgent: z.string().min(10, "User-Agent requis"),
  }),
  z.object({
    format: z.literal("playwright"),
    storageState: z.string(),
  }),
]);
export type SessionImport = z.infer<typeof SessionImportSchema>;

export interface SessionBundle {
  format: "manual" | "cookie-editor" | "playwright";
  cookies: Record<string, string>;
  localStorage: Record<string, string>;
  userId: string | null;
  userAgent: string;
  importedAt: string;
}

/** Décodage JWT payload sans vérification (c'est notre propre token importé). */
export function jwtExpiry(token: string): Date | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

interface CookieEditorEntry {
  name: string;
  value: string;
  domain?: string;
}

interface PlaywrightStorageState {
  cookies?: Array<{ name: string; value: string; domain?: string }>;
  origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
}

export function normalizeSessionImport(input: SessionImport): SessionBundle {
  const now = new Date().toISOString();
  if (input.format === "manual") {
    return {
      format: "manual",
      cookies: { luat: input.luat, ...(input.extraCookies ?? {}) },
      localStorage: {},
      userId: input.userId,
      userAgent: input.userAgent,
      importedAt: now,
    };
  }
  if (input.format === "cookie-editor") {
    let parsed: CookieEditorEntry[];
    try {
      parsed = JSON.parse(input.json);
    } catch {
      throw badRequest("JSON Cookie-Editor invalide");
    }
    if (!Array.isArray(parsed) || parsed.length === 0) throw badRequest("Export Cookie-Editor vide");
    const cookies: Record<string, string> = {};
    for (const c of parsed) {
      if (typeof c.name === "string" && typeof c.value === "string") cookies[c.name] = c.value;
    }
    const luat = cookies["luat"];
    if (!luat) throw badRequest("Cookie 'luat' absent de l'export");
    return {
      format: "cookie-editor",
      cookies,
      localStorage: {},
      userId: cookies["lbc_user_id"] ?? null,
      userAgent: input.userAgent,
      importedAt: now,
    };
  }
  let parsed: PlaywrightStorageState;
  try {
    parsed = JSON.parse(input.storageState);
  } catch {
    throw badRequest("storageState Playwright invalide (JSON attendu)");
  }
  const cookies: Record<string, string> = {};
  for (const c of parsed.cookies ?? []) cookies[c.name] = c.value;
  const localStorage: Record<string, string> = {};
  for (const origin of parsed.origins ?? []) {
    for (const kv of origin.localStorage ?? []) localStorage[kv.name] = kv.value;
  }
  const luat = cookies["luat"];
  if (!luat) throw badRequest("Cookie 'luat' absent du storageState");
  const ua = cookies["__user_agent__"] ?? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  return {
    format: "playwright",
    cookies,
    localStorage,
    userId: cookies["lbc_user_id"] ?? null,
    userAgent: ua,
    importedAt: now,
  };
}

export function sessionExpiresAt(bundle: Pick<SessionBundle, "cookies">): Date | null {
  const luat = bundle.cookies["luat"];
  return luat ? jwtExpiry(luat) : null;
}
