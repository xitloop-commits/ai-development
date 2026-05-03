import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { getInternalApiSecret } from "./auth";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;

/**
 * Public procedure — no per-procedure auth check.
 *
 * Today, with tRPC mounted at /api/trpc behind the express
 * authMiddleware, every publicProcedure is still gated at the network
 * boundary. Use this for procedures that are explicitly safe to be
 * fully public if the tRPC mount path ever changes (status / probe
 * shapes only).
 */
export const publicProcedure = t.procedure;

/**
 * Protected procedure — defense-in-depth on top of the express auth
 * middleware. Validates X-Internal-Token from the request context.
 * Use for any mutation or for queries that return secrets/state.
 *
 * Mirrors authMiddleware semantics:
 *   - REQUIRE_INTERNAL_AUTH != "true"  → no-op (warn-only via express)
 *   - INTERNAL_API_SECRET empty        → no-op (warn-only via express)
 *   - otherwise: throws UNAUTHORIZED on missing/invalid header.
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  const enforced =
    (process.env.REQUIRE_INTERNAL_AUTH ?? "").toLowerCase() === "true";
  const expected = getInternalApiSecret();
  if (!enforced || !expected) {
    return next({ ctx });
  }
  const provided = (ctx.req?.header("x-internal-token") ?? "") as string;
  if (
    provided.length !== expected.length ||
    !constantTimeEqual(provided, expected)
  ) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "missing or invalid X-Internal-Token",
    });
  }
  return next({ ctx });
});

function constantTimeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
