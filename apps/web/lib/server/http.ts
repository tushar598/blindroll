import { type NextRequest, NextResponse, connection } from "next/server";
import { type FetchLike, ValidationError } from "@blindroll/core";
import { HttpError, approverOrgIds } from "./auth";
import { serverConfig } from "./config";
import { db } from "./db";
import type { RunDeps } from "./runs";
import { SESSION_COOKIE, readSessionToken } from "./session";

const liveFetch: FetchLike = (url, init) => fetch(url, { ...init, cache: "no-store" });

/** Dependencies for the run service. The AI client exists only when NEAR_AI_LIVE=1 (docs/05). */
export function runDeps(): RunDeps {
  const config = serverConfig();
  return { db: db(), config, ...(config.aiLive ? { ai: { apiKey: process.env.NEAR_AI_API_KEY!, fetch: liveFetch } } : {}) };
}

/** The signed-in approver's account ID, or a 401. Re-checks approver membership on every request. */
export async function requireApprover(req: NextRequest): Promise<string> {
  const accountId = await readSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!accountId) throw new HttpError(401, "unauthenticated", "Sign in with your NEAR wallet first");
  if (approverOrgIds(db(), accountId).length === 0) throw new HttpError(403, "not_approver", "This account is not an approver");
  return accountId;
}

/** Cookie-authenticated writes must come from our own origin. */
function assertSameOrigin(req: NextRequest) {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (origin && origin !== new URL(serverConfig().appUrl).origin && origin !== req.nextUrl.origin) {
    throw new HttpError(403, "bad_origin", "Cross-site request refused");
  }
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "bad_request", "Expected a JSON object body");
}

/** Wraps a handler: uniform JSON errors, and never leaks internals or decrypted data in a 500. */
export function handle<C>(fn: (req: NextRequest, ctx: C) => Promise<Response>) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    // Every API route is per-request: opt out of prerendering before touching cookies or the database.
    await connection();
    try {
      assertSameOrigin(req);
      return await fn(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return NextResponse.json({ error: { code: err.code, message: err.message } }, { status: err.status });
      if (err instanceof ValidationError) return NextResponse.json({ error: { code: "validation", message: err.message } }, { status: 400 });
      console.error(`${req.method} ${req.nextUrl.pathname} failed:`, err instanceof Error ? err.name : "unknown error");
      return NextResponse.json({ error: { code: "internal", message: "Something went wrong on the server" } }, { status: 500 });
    }
  };
}

export type RunCtx = { params: Promise<{ runKey: string }> };
