/**
 * Step 0.2 — Drizzle-level schema contract.
 *
 * `getTableConfig` is what forces Drizzle to resolve the lazy pieces
 * of a table definition — the `references(() => ...)` targets and the
 * index-builder callbacks — so this test both pins the contract the
 * later phases depend on (tenant lookup indexes, cascade rules) and
 * exercises code the SQL-level migration tests never touch.
 */
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  account,
  consentRecords,
  invitation,
  member,
  organization,
  plaidItems,
  session,
  transactions,
  user,
  verification,
} from "../../src/db/schema";

const tables = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  consentRecords,
  plaidItems,
  transactions,
} as const;

function indexNames(table: (typeof tables)[keyof typeof tables]): string[] {
  return getTableConfig(table).indexes.map((i) => i.config.name ?? "<unnamed>");
}

function fkRules(table: (typeof tables)[keyof typeof tables]) {
  return getTableConfig(table).foreignKeys.map((fk) => ({
    onDelete: fk.onDelete ?? "no action",
    columns: fk
      .reference()
      .columns.map((c) => c.name)
      .join(","),
    foreignColumns: fk
      .reference()
      .foreignColumns.map((c) => c.name)
      .join(","),
  }));
}

describe("schema config", () => {
  it("marks id as the primary key on every table", () => {
    for (const [name, table] of Object.entries(tables)) {
      const cfg = getTableConfig(table);
      const id = cfg.columns.find((c) => c.name === "id");
      expect(id, `missing id column on ${name}`).toBeDefined();
      expect(id?.primary, `id not primary on ${name}`).toBe(true);
    }
  });

  it("declares the tenant-scoped indexes each phase will query through", () => {
    expect(indexNames(session)).toEqual(["session_user_id_idx"]);
    expect(indexNames(account)).toEqual(["account_user_id_idx"]);
    expect(indexNames(verification)).toEqual(["verification_identifier_idx"]);
    expect(indexNames(organization)).toEqual(["organization_slug_idx"]);
    expect(indexNames(member)).toEqual([
      "member_organization_id_idx",
      "member_user_id_idx",
    ]);
    expect(indexNames(invitation)).toEqual([
      "invitation_organization_id_idx",
      "invitation_email_idx",
    ]);
    expect(indexNames(consentRecords)).toEqual([
      "consent_records_org_user_idx",
      "consent_records_user_id_idx",
    ]);
    expect(indexNames(user)).toEqual([]);
    expect(indexNames(plaidItems)).toEqual([
      "plaid_items_org_idx",
      "plaid_items_item_id_idx",
    ]);
    expect(indexNames(transactions)).toEqual([
      "transactions_org_date_idx",
      "transactions_item_txn_idx",
    ]);
  });

  it("resolves every foreign key and pins its cascade rule", () => {
    // Cascades better-auth declares (user-owned rows die with the user).
    expect(fkRules(session)).toEqual([
      { onDelete: "cascade", columns: "user_id", foreignColumns: "id" },
    ]);
    expect(fkRules(account)).toEqual([
      { onDelete: "cascade", columns: "user_id", foreignColumns: "id" },
    ]);
    expect(fkRules(member)).toEqual(
      expect.arrayContaining([
        { onDelete: "cascade", columns: "user_id", foreignColumns: "id" },
        {
          onDelete: "no action",
          columns: "organization_id",
          foreignColumns: "id",
        },
      ]),
    );
    // Consent rows follow their tenant and user.
    expect(fkRules(consentRecords)).toEqual(
      expect.arrayContaining([
        {
          onDelete: "cascade",
          columns: "organization_id",
          foreignColumns: "id",
        },
        { onDelete: "cascade", columns: "user_id", foreignColumns: "id" },
      ]),
    );
    // Invitation mirrors better-auth: no cascade on either FK.
    expect(fkRules(invitation)).toEqual([
      {
        onDelete: "no action",
        columns: "organization_id",
        foreignColumns: "id",
      },
      { onDelete: "no action", columns: "inviter_id", foreignColumns: "id" },
    ]);
    // Stored bank items die with their tenant.
    expect(fkRules(plaidItems)).toEqual([
      {
        onDelete: "cascade",
        columns: "organization_id",
        foreignColumns: "id",
      },
    ]);
    // Transactions follow their tenant AND their owning item.
    expect(fkRules(transactions)).toEqual(
      expect.arrayContaining([
        {
          onDelete: "cascade",
          columns: "organization_id",
          foreignColumns: "id",
        },
        {
          onDelete: "cascade",
          columns: "plaid_item_id",
          foreignColumns: "id",
        },
      ]),
    );
  });
});
