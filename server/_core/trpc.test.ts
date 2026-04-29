/**
 * Tests for tRPC `protectedProcedure` (B1-followup).
 *
 * The express authMiddleware already gates /api/* at the network boundary,
 * but tRPC procedures previously ran with no per-procedure check. Anyone
 * who could reach /api/trpc could mutate state. protectedProcedure mirrors
 * authMiddleware: enforced when REQUIRE_INTERNAL_AUTH=true AND
 * INTERNAL_API_SECRET is set; warn-only otherwise (matches the rollout
 * semantics of the express middleware).
 *
 * Exercises the full procedure: builds a fake tRPC caller using the same
 * router shape the real app uses, and asserts UNAUTHORIZED throws on
 * missing/wrong tokens when enforcement is on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Request } from "express";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "./trpc";
import { _resetAuthForTesting } from "./auth";

const origEnv = { ...process.env };

// Build a router that exposes one mutation gated by protectedProcedure.
const testRouter = router({
  doMutate: protectedProcedure
    .input(z.object({ x: z.number() }))
    .mutation(({ input }) => ({ ok: true, x: input.x })),
});

function fakeReq(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers["x-internal-token"] = token;
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

beforeEach(() => {
  _resetAuthForTesting();
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.REQUIRE_INTERNAL_AUTH;
});

afterEach(() => {
  process.env = { ...origEnv };
  _resetAuthForTesting();
});

describe("protectedProcedure (B1-followup)", () => {
  it("warn-only mode: no token → mutation runs", async () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    delete process.env.REQUIRE_INTERNAL_AUTH;
    const caller = testRouter.createCaller({ req: fakeReq(null) } as any);
    const result = await caller.doMutate({ x: 1 });
    expect(result).toEqual({ ok: true, x: 1 });
  });

  it("warn-only mode: wrong token → mutation runs", async () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "false";
    const caller = testRouter.createCaller({ req: fakeReq("nope") } as any);
    const result = await caller.doMutate({ x: 2 });
    expect(result).toEqual({ ok: true, x: 2 });
  });

  it("no INTERNAL_API_SECRET configured: mutation runs (warn-only fallback)", async () => {
    delete process.env.INTERNAL_API_SECRET;
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const caller = testRouter.createCaller({ req: fakeReq(null) } as any);
    const result = await caller.doMutate({ x: 3 });
    expect(result).toEqual({ ok: true, x: 3 });
  });

  it("enforced + missing token → UNAUTHORIZED", async () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const caller = testRouter.createCaller({ req: fakeReq(null) } as any);
    await expect(caller.doMutate({ x: 4 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("enforced + wrong token → UNAUTHORIZED", async () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const caller = testRouter.createCaller({ req: fakeReq("nope") } as any);
    await expect(caller.doMutate({ x: 5 })).rejects.toBeInstanceOf(TRPCError);
  });

  it("enforced + matching token → mutation runs", async () => {
    process.env.INTERNAL_API_SECRET = "topsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const caller = testRouter.createCaller({ req: fakeReq("topsecret") } as any);
    const result = await caller.doMutate({ x: 6 });
    expect(result).toEqual({ ok: true, x: 6 });
  });

  it("enforced + length-mismatch token → UNAUTHORIZED (constant-time compare)", async () => {
    process.env.INTERNAL_API_SECRET = "shortsecret";
    process.env.REQUIRE_INTERNAL_AUTH = "true";
    const caller = testRouter.createCaller({
      req: fakeReq("this-is-much-much-longer-than-the-real-secret"),
    } as any);
    await expect(caller.doMutate({ x: 7 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
