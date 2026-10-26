/**
 * Phase 0.3 — Better Auth sessions and organizations, TDD'd against a
 * dedicated scratch database (the tenancy suite truncates shared
 * tables in parallel, so this file never touches the main test DB).
 *
 * Error shapes asserted below are pinned from empirical probes of
 * better-auth@1.7.13: APIError exposes `.status` as a string enum and
 * the machine-readable code at `.body.code`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScratchDatabase } from "../helpers/scratch-db";
import { createAuth } from "../../src/auth/auth";

const DB = "finbrief_auth_test";
/**
 * Placeholder fixture values — well-known non-credentials that only
 * ever authenticate against the throwaway test database. Declared as
 * named constants so the literals exist in exactly one place.
 */
const LOGIN_FIXTURE = "password1234";
const SIGNING_FIXTURE = "test-secret-not-for-production";
const BASE_URL = "http://localhost:3000";
const ORG = { name: "Acme Finance", slug: "acme-finance" };

type Auth = ReturnType<typeof createAuth>;

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
let auth: Auth;

/** Sign up; returns nothing (assertions read the database). */
async function signUp(email: string, name: string): Promise<void> {
  await auth.api.signUpEmail({
    body: { email, name, password: LOGIN_FIXTURE },
  });
}

/** Sign in and return the cookie headers for subsequent api calls. */
async function signIn(email: string): Promise<Headers> {
  const res = await auth.api.signInEmail({
    body: { email, password: LOGIN_FIXTURE },
    returnHeaders: true,
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return new Headers({ cookie });
}

/** Unwrap `{ headers, response }` returns to just the response. */
function payload(res: unknown): Record<string, unknown> {
  const wrapped = res as { response?: unknown };
  return (wrapped?.response ?? {}) as Record<string, unknown>;
}

interface Fixtures {
  alice: Headers;
  bob: Headers;
  carol: Headers;
  dave: Headers;
  orgId: string;
  ghostInvitationId: string;
}
let fx: Fixtures;

const userIdByEmail = async (email: string): Promise<string | null> => {
  const res = await scratch.pool.query(
    `SELECT id FROM "user" WHERE email = $1`,
    [email],
  );
  return (res.rows[0] as { id: string } | undefined)?.id ?? null;
};

beforeAll(async () => {
  scratch = await createScratchDatabase(DB);
  await scratch.migrate();
  auth = createAuth(scratch.pool, {
    secret: SIGNING_FIXTURE,
    baseURL: BASE_URL,
  });

  await signUp("alice@example.com", "Alice");
  const alice = await signIn("alice@example.com");
  const org = await auth.api.createOrganization({
    headers: alice,
    body: ORG,
    returnHeaders: true,
  });

  await signUp("bob@example.com", "Bob");
  const bob = await signIn("bob@example.com");
  const invite = await auth.api.createInvitation({
    headers: alice,
    body: { email: "bob@example.com", role: "member" },
    returnHeaders: true,
  });
  await auth.api.acceptInvitation({
    headers: bob,
    body: { invitationId: (payload(invite).id as string) ?? "" },
  });

  await signUp("carol@example.com", "Carol");
  const carol = await signIn("carol@example.com");
  await signUp("dave@example.com", "Dave");
  const dave = await signIn("dave@example.com");

  // A pending invitation addressed to nobody — dave will try to accept it.
  const ghost = await auth.api.createInvitation({
    headers: alice,
    body: { email: "ghost@example.com", role: "member" },
    returnHeaders: true,
  });

  fx = {
    alice,
    bob,
    carol,
    dave,
    orgId: payload(org).id as string,
    ghostInvitationId: payload(ghost).id as string,
  };
}, 60_000);

afterAll(async () => {
  await scratch?.destroy();
});

describe("sign-up and sign-in", () => {
  it("creates the user row and a credential account with a hashed password", async () => {
    const userId = await userIdByEmail("alice@example.com");
    expect(userId).toBeTruthy();

    const res = await scratch.pool.query(
      `SELECT provider_id, password, account_id FROM account WHERE user_id = $1`,
      [userId],
    );
    expect(res.rows).toHaveLength(1);
    const account = res.rows[0] as {
      provider_id: string;
      password: string | null;
      account_id: string;
    };
    expect(account.provider_id).toBe("credential");
    expect(account.password).toBeTruthy();
    expect(account.password).not.toBe(LOGIN_FIXTURE);
    expect(account.account_id).toBe(userId);
  });

  it("issues a session cookie that resolves to the signed-in user", async () => {
    const res = await auth.api.signInEmail({
      body: { email: "alice@example.com", password: LOGIN_FIXTURE },
      returnHeaders: true,
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("better-auth.session_token=");

    const cookie = new Headers({ cookie: setCookie.split(";")[0] ?? "" });
    const session = await auth.api.getSession({
      headers: cookie,
      returnHeaders: true,
    });
    const user = payload(session).user as { email?: string } | undefined;
    expect(user?.email).toBe("alice@example.com");

    const rows = await scratch.pool.query(
      `SELECT token FROM session WHERE user_id = (SELECT id FROM "user" WHERE email = $1)`,
      ["alice@example.com"],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it("resolves no session without a cookie", async () => {
    const session = await auth.api.getSession({
      headers: new Headers(),
      returnHeaders: true,
    });
    expect(session.response).toBeFalsy();
  });
});

describe("organization and invitation writes land in the right tenant", () => {
  it("creates the organization with its creator as owner", async () => {
    const org = await scratch.pool.query(
      `SELECT id FROM organization WHERE slug = $1`,
      [ORG.slug],
    );
    expect(org.rows).toHaveLength(1);
    expect((org.rows[0] as { id: string }).id).toBe(fx.orgId);

    const aliceId = await userIdByEmail("alice@example.com");
    const member = await scratch.pool.query(
      `SELECT role FROM member WHERE organization_id = $1 AND user_id = $2`,
      [fx.orgId, aliceId],
    );
    expect(member.rows).toHaveLength(1);
    expect((member.rows[0] as { role: string }).role).toBe("owner");
  });

  it("runs the full invite cycle: pending row, then accepted membership", async () => {
    await signUp("invitee@example.com", "Invitee");
    const invitee = await signIn("invitee@example.com");

    const invite = await auth.api.createInvitation({
      headers: fx.alice,
      body: { email: "invitee@example.com", role: "member" },
      returnHeaders: true,
    });
    const inviteId = payload(invite).id as string;
    expect(inviteId).toBeTruthy();

    const before = await scratch.pool.query(
      `SELECT status, inviter_id, organization_id FROM invitation WHERE id = $1`,
      [inviteId],
    );
    const row = before.rows[0] as {
      status: string;
      inviter_id: string;
      organization_id: string;
    };
    expect(row.status).toBe("pending");
    expect(row.organization_id).toBe(fx.orgId);
    const aliceId = await userIdByEmail("alice@example.com");
    expect(row.inviter_id).toBe(aliceId);

    const accepted = await auth.api.acceptInvitation({
      headers: invitee,
      body: { invitationId: inviteId },
      returnHeaders: true,
    });
    expect((payload(accepted).invitation as { status?: string }).status).toBe(
      "accepted",
    );

    const inviteeId = await userIdByEmail("invitee@example.com");
    const member = await scratch.pool.query(
      `SELECT role FROM member WHERE organization_id = $1 AND user_id = $2`,
      [fx.orgId, inviteeId],
    );
    expect(member.rows).toHaveLength(1);
    expect((member.rows[0] as { role: string }).role).toBe("member");
  });
});

describe("cross-tenant and role isolation (table-driven)", () => {
  interface DenialCase {
    ctx: string;
    name: string;
    status: string;
    code: string;
    run: () => Promise<unknown>;
  }

  const denials: DenialCase[] = [
    {
      ctx: "outsider",
      name: "setActiveOrganization into a foreign tenant",
      status: "FORBIDDEN",
      code: "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION",
      run: () =>
        auth.api.setActiveOrganization({
          headers: fx.carol,
          body: { organizationId: fx.orgId },
          returnHeaders: true,
        }),
    },
    {
      ctx: "outsider",
      name: "getOrganization of a foreign tenant",
      status: "FORBIDDEN",
      code: "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION",
      run: () =>
        auth.api.getOrganization({
          headers: fx.carol,
          query: { organizationId: fx.orgId },
          returnHeaders: true,
        }),
    },
    {
      ctx: "outsider",
      name: "listMembers without an active organization",
      status: "BAD_REQUEST",
      code: "NO_ACTIVE_ORGANIZATION",
      run: () =>
        auth.api.listMembers({
          headers: fx.carol,
          returnHeaders: true,
        }),
    },
    {
      ctx: "outsider",
      name: "createInvitation without an active organization",
      status: "BAD_REQUEST",
      code: "ORGANIZATION_NOT_FOUND",
      run: () =>
        auth.api.createInvitation({
          headers: fx.carol,
          body: { email: "intruder@example.com", role: "member" },
          returnHeaders: true,
        }),
    },
    {
      ctx: "plain member",
      name: "updateOrganization they only belong to",
      status: "FORBIDDEN",
      code: "YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_ORGANIZATION",
      run: () =>
        auth.api.updateOrganization({
          headers: fx.bob,
          body: { data: { name: "Hijacked" } },
          returnHeaders: true,
        }),
    },
    {
      ctx: "plain member",
      name: "createInvitation from a role without invite permission",
      status: "FORBIDDEN",
      code: "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION",
      run: () =>
        auth.api.createInvitation({
          headers: fx.bob,
          body: { email: "recruited@example.com", role: "member" },
          returnHeaders: true,
        }),
    },
    {
      ctx: "wrong recipient",
      name: "acceptInvitation addressed to someone else",
      status: "FORBIDDEN",
      code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
      run: () =>
        auth.api.acceptInvitation({
          headers: fx.dave,
          body: { invitationId: fx.ghostInvitationId },
          returnHeaders: true,
        }),
    },
  ];

  for (const c of denials) {
    it(`${c.ctx}: ${c.name} → ${c.status}/${c.code}`, async () => {
      const caught = await c.run().then(
        () => null,
        (e: unknown) => e,
      );
      expect(caught, "expected the call to be denied").not.toBeNull();
      const err = caught as { status?: string; body?: { code?: string } };
      expect(err.status).toBe(c.status);
      expect(err.body?.code).toBe(c.code);
    });
  }

  it("outsider's organization list stays empty (no tenant leak)", async () => {
    const res = await auth.api.listOrganizations({
      headers: fx.carol,
      returnHeaders: true,
    });
    expect(res.response).toEqual([]);
  });
});

describe("auth configuration contract", () => {
  it("refuses to build without a secret", () => {
    const prev = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      expect(() => createAuth(scratch.pool)).toThrow(/secret/i);
    } finally {
      if (prev !== undefined) process.env.BETTER_AUTH_SECRET = prev;
    }
  });

  it("accepts secret and base URL from the environment", () => {
    const prevSecret = process.env.BETTER_AUTH_SECRET;
    const prevUrl = process.env.BETTER_AUTH_URL;
    process.env["BETTER_AUTH_SECRET"] = "env-secret-for-test";
    process.env.BETTER_AUTH_URL = "https://env.example.com";
    try {
      expect(() => createAuth(scratch.pool)).not.toThrow();
    } finally {
      if (prevSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = prevSecret;
      if (prevUrl === undefined) delete process.env.BETTER_AUTH_URL;
      else process.env.BETTER_AUTH_URL = prevUrl;
    }
  });
});
