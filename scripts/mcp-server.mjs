#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function resolveDatabaseFile() {
  if (process.env.WALLOS_DB_FILE) {
    return resolve(process.env.WALLOS_DB_FILE);
  }

  const desktopDb = join(
    homedir(),
    "Library",
    "Application Support",
    "app.wallos.desktop",
    "wallos.db",
  );
  if (existsSync(desktopDb)) {
    return desktopDb;
  }

  return resolve("db", "wallos.db");
}

const dbFile = resolveDatabaseFile();
let databaseQueue = Promise.resolve();

function withDatabase(work) {
  const next = databaseQueue.then(work, work);
  databaseQueue = next.catch(() => {});
  return next;
}

function sqlString(value) {
  if (value === null || value === undefined || value === "") {
    return "NULL";
  }

  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback === null ? "NULL" : String(fallback);
  }

  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Expected a finite number, received ${value}`);
  }

  return String(number);
}

function sqlInteger(value, fallback = null) {
  if (value === null || value === undefined || value === "") {
    return fallback === null ? "NULL" : String(fallback);
  }

  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new Error(`Expected an integer, received ${value}`);
  }

  return String(number);
}

function sqlBoolean(value, fallback = false) {
  return value ?? fallback ? "1" : "0";
}

function limitClause(limit, offset) {
  const safeLimit = Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const safeOffset = Math.max(offset ?? 0, 0);
  return `LIMIT ${safeLimit} OFFSET ${safeOffset}`;
}

async function runSql(sql, { json = true } = {}) {
  if (!existsSync(dbFile)) {
    throw new Error(
      `Wallos database not found at ${dbFile}. Open the desktop app once or set WALLOS_DB_FILE.`,
    );
  }

  const args = json ? ["-json", dbFile, sql] : [dbFile, sql];
  try {
    const { stdout } = await execFileAsync("sqlite3", args, {
      maxBuffer: 1024 * 1024 * 10,
    });
    return json ? JSON.parse(stdout || "[]") : stdout;
  } catch (error) {
    const stderr = error.stderr ? ` ${error.stderr}` : "";
    throw new Error(`SQLite query failed.${stderr}`);
  }
}

async function execSql(sql) {
  await runSql(sql, { json: false });
}

async function getDesktopUser() {
  const users = await runSql(
    "SELECT id, username, main_currency FROM user WHERE id = 1 LIMIT 1",
  );
  if (users.length === 0) {
    throw new Error("Wallos desktop user is missing. Open the desktop app once to initialize it.");
  }
  return users[0];
}

async function getDefaults() {
  const user = await getDesktopUser();
  const [household, category, paymentMethod] = await Promise.all([
    runSql("SELECT id FROM household WHERE user_id = 1 ORDER BY id ASC LIMIT 1"),
    runSql("SELECT id FROM categories WHERE user_id = 1 ORDER BY id ASC LIMIT 1"),
    runSql("SELECT id FROM payment_methods WHERE user_id = 1 ORDER BY id ASC LIMIT 1"),
  ]);

  return {
    currencyId: user.main_currency,
    payerUserId: household[0]?.id ?? null,
    categoryId: category[0]?.id ?? null,
    paymentMethodId: paymentMethod[0]?.id ?? null,
  };
}

function toolResult(text, data) {
  return {
    content: [{ type: "text", text }],
    structuredContent: data,
  };
}

function subscriptionSelectSql(where = "1 = 1", orderLimit = "") {
  return `
    SELECT
      s.id,
      s.name,
      s.price,
      s.next_payment,
      s.start_date,
      s.cycle,
      cy.name AS cycle_name,
      s.frequency,
      s.auto_renew,
      s.inactive,
      s.notify,
      s.notes,
      s.url,
      s.currency_id,
      c.code AS currency_code,
      c.symbol AS currency_symbol,
      s.category_id,
      cat.name AS category_name,
      s.payment_method_id,
      pm.name AS payment_method_name,
      s.payer_user_id,
      h.name AS payer_name
    FROM subscriptions s
    LEFT JOIN currencies c ON c.id = s.currency_id AND c.user_id = s.user_id
    LEFT JOIN categories cat ON cat.id = s.category_id AND cat.user_id = s.user_id
    LEFT JOIN payment_methods pm ON pm.id = s.payment_method_id AND pm.user_id = s.user_id
    LEFT JOIN household h ON h.id = s.payer_user_id AND h.user_id = s.user_id
    LEFT JOIN cycles cy ON cy.id = s.cycle
    WHERE s.user_id = 1 AND ${where}
    ${orderLimit}
  `;
}

const server = new McpServer({
  name: "wallos",
  version: "0.1.0",
});

server.registerTool(
  "wallos_list_subscriptions",
  {
    title: "List Wallos subscriptions",
    description: "List subscriptions from the local Wallos desktop database with optional status and search filters.",
    inputSchema: {
      status: z.enum(["active", "inactive", "all"]).default("active"),
      search: z.string().optional().describe("Case-insensitive name search."),
      limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
      offset: z.number().int().min(0).default(0),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ status, search, limit, offset }) => withDatabase(async () => {
    const filters = [];
    if (status === "active") filters.push("s.inactive = 0");
    if (status === "inactive") filters.push("s.inactive = 1");
    if (search) filters.push(`LOWER(s.name) LIKE LOWER(${sqlString(`%${search}%`)})`);

    const subscriptions = await runSql(
      subscriptionSelectSql(
        filters.length > 0 ? filters.join(" AND ") : "1 = 1",
        `ORDER BY s.inactive ASC, s.next_payment ASC ${limitClause(limit, offset)}`,
      ),
    );
    return toolResult(`Found ${subscriptions.length} subscription(s).`, { subscriptions, dbFile });
  }),
);

server.registerTool(
  "wallos_get_subscription",
  {
    title: "Get a Wallos subscription",
    description: "Get one subscription by id from the local Wallos desktop database.",
    inputSchema: { id: z.number().int().positive() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async ({ id }) => withDatabase(async () => {
    const rows = await runSql(subscriptionSelectSql(`s.id = ${sqlInteger(id)}`, "LIMIT 1"));
    if (rows.length === 0) {
      throw new Error(`Subscription ${id} was not found for the desktop user.`);
    }
    return toolResult(`Subscription ${id}: ${rows[0].name}`, { subscription: rows[0], dbFile });
  }),
);

server.registerTool(
  "wallos_list_reference_data",
  {
    title: "List Wallos reference data",
    description: "List currencies, categories, payment methods, cycles, frequencies, and household members.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  async () => withDatabase(async () => {
    const [currencies, categories, paymentMethods, cycles, frequencies, household] =
      await Promise.all([
        runSql("SELECT id, name, symbol, code, rate FROM currencies WHERE user_id = 1 ORDER BY id ASC"),
        runSql('SELECT id, name, "order" FROM categories WHERE user_id = 1 ORDER BY "order" ASC, id ASC'),
        runSql('SELECT id, name, icon, enabled, "order" FROM payment_methods WHERE user_id = 1 ORDER BY "order" ASC, id ASC'),
        runSql("SELECT id, days, name FROM cycles ORDER BY id ASC"),
        runSql("SELECT id, name FROM frequencies ORDER BY id ASC"),
        runSql("SELECT id, name FROM household WHERE user_id = 1 ORDER BY id ASC"),
      ]);

    return toolResult("Loaded Wallos reference data.", {
      currencies,
      categories,
      paymentMethods,
      cycles,
      frequencies,
      household,
      dbFile,
    });
  }),
);

const subscriptionInput = {
  name: z.string().min(1),
  price: z.number().nonnegative(),
  next_payment: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; defaults to next_payment."),
  currency_id: z.number().int().positive().optional(),
  cycle: z.number().int().positive().default(3).describe("Wallos cycle id. Default 3 is Monthly."),
  frequency: z.number().int().positive().default(1),
  payment_method_id: z.number().int().positive().optional(),
  payer_user_id: z.number().int().positive().optional(),
  category_id: z.number().int().positive().optional(),
  notes: z.string().default(""),
  url: z.string().default(""),
  auto_renew: z.boolean().default(true),
  notify: z.boolean().default(false),
  notify_days_before: z.number().int().default(-1),
  inactive: z.boolean().default(false),
  cancellation_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
};

server.registerTool(
  "wallos_create_subscription",
  {
    title: "Create a Wallos subscription",
    description: "Create a subscription for the local Wallos desktop user.",
    inputSchema: subscriptionInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (input) => withDatabase(async () => {
    const defaults = await getDefaults();
    const startDate = input.start_date ?? input.next_payment;
    const sql = `
      INSERT INTO subscriptions (
        name, logo, price, currency_id, next_payment, cycle, frequency, notes,
        payment_method_id, payer_user_id, category_id, notify, inactive, url,
        notify_days_before, user_id, cancellation_date, replacement_subscription_id,
        auto_renew, start_date
      ) VALUES (
        ${sqlString(input.name)}, '', ${sqlNumber(input.price)}, ${sqlInteger(input.currency_id, defaults.currencyId)},
        ${sqlString(input.next_payment)}, ${sqlInteger(input.cycle, 3)}, ${sqlInteger(input.frequency, 1)}, ${sqlString(input.notes)},
        ${sqlInteger(input.payment_method_id, defaults.paymentMethodId)}, ${sqlInteger(input.payer_user_id, defaults.payerUserId)},
        ${sqlInteger(input.category_id, defaults.categoryId)}, ${sqlBoolean(input.notify)}, ${sqlBoolean(input.inactive)},
        ${sqlString(input.url)}, ${sqlInteger(input.notify_days_before, -1)}, 1, ${sqlString(input.cancellation_date)},
        NULL, ${sqlBoolean(input.auto_renew, true)}, ${sqlString(startDate)}
      )
      RETURNING id;
    `;
    const [{ id }] = await runSql(sql);
    const [subscription] = await runSql(subscriptionSelectSql(`s.id = ${sqlInteger(id)}`, "LIMIT 1"));
    return toolResult(`Created subscription ${id}.`, { subscription, dbFile });
  }),
);

server.registerTool(
  "wallos_update_subscription",
  {
    title: "Update a Wallos subscription",
    description: "Update selected fields on an existing local Wallos subscription.",
    inputSchema: {
      id: z.number().int().positive(),
      ...Object.fromEntries(Object.entries(subscriptionInput).map(([key, schema]) => [key, schema.optional()])),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ id, ...input }) => withDatabase(async () => {
    const fields = [];
    const fieldMap = {
      name: (value) => `name = ${sqlString(value)}`,
      price: (value) => `price = ${sqlNumber(value)}`,
      next_payment: (value) => `next_payment = ${sqlString(value)}`,
      start_date: (value) => `start_date = ${sqlString(value)}`,
      currency_id: (value) => `currency_id = ${sqlInteger(value)}`,
      cycle: (value) => `cycle = ${sqlInteger(value)}`,
      frequency: (value) => `frequency = ${sqlInteger(value)}`,
      payment_method_id: (value) => `payment_method_id = ${sqlInteger(value)}`,
      payer_user_id: (value) => `payer_user_id = ${sqlInteger(value)}`,
      category_id: (value) => `category_id = ${sqlInteger(value)}`,
      notes: (value) => `notes = ${sqlString(value)}`,
      url: (value) => `url = ${sqlString(value)}`,
      auto_renew: (value) => `auto_renew = ${sqlBoolean(value)}`,
      notify: (value) => `notify = ${sqlBoolean(value)}`,
      notify_days_before: (value) => `notify_days_before = ${sqlInteger(value)}`,
      inactive: (value) => `inactive = ${sqlBoolean(value)}`,
      cancellation_date: (value) => `cancellation_date = ${sqlString(value)}`,
    };

    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && fieldMap[key]) {
        fields.push(fieldMap[key](value));
      }
    }

    if (fields.length === 0) {
      throw new Error("No fields were provided to update.");
    }

    await execSql(`UPDATE subscriptions SET ${fields.join(", ")} WHERE id = ${sqlInteger(id)} AND user_id = 1`);
    const [subscription] = await runSql(subscriptionSelectSql(`s.id = ${sqlInteger(id)}`, "LIMIT 1"));
    if (!subscription) {
      throw new Error(`Subscription ${id} was not found for the desktop user.`);
    }
    return toolResult(`Updated subscription ${id}.`, { subscription, dbFile });
  }),
);

server.registerTool(
  "wallos_delete_subscription",
  {
    title: "Delete a Wallos subscription",
    description: "Delete a subscription by id from the local Wallos desktop database.",
    inputSchema: { id: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  async ({ id }) => withDatabase(async () => {
    const before = await runSql(`SELECT id, name FROM subscriptions WHERE id = ${sqlInteger(id)} AND user_id = 1`);
    if (before.length === 0) {
      throw new Error(`Subscription ${id} was not found for the desktop user.`);
    }
    await execSql(`DELETE FROM subscriptions WHERE id = ${sqlInteger(id)} AND user_id = 1`);
    return toolResult(`Deleted subscription ${id}.`, { deleted: before[0], dbFile });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
