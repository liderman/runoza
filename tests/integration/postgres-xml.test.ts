import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Pool } from "pg";

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error("TEST_DATABASE_URL must point to isolated test PostgreSQL");

test(
  "PostgreSQL XML ABI: XPath, XMLTABLE, xml2, Unicode and error recovery",
  { timeout: 20000 },
  async () => {
    const name = "runoza_xml_" + randomUUID().replaceAll("-", "");
    const admin = new Pool({ connectionString: url });
    let pool: Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      const target = new URL(url!);
      target.pathname = "/" + name;
      pool = new Pool({ connectionString: target.href });
      const client = await pool.connect();
      try {
        const before = await client.query("SELECT pg_backend_pid() AS pid");
        const script = (
          await readFile("tests/fixtures/postgres-xml.sql", "utf8")
        ).replace(/^\\set[^\n]*\n/gm, "");
        await client.query(script);
        const after = await client.query("SELECT pg_backend_pid() AS pid");
        assert.equal(after.rows[0].pid, before.rows[0].pid);
        const locales = await client.query(
          "SELECT datcollversion,pg_database_collation_actual_version(oid) AS actual FROM pg_database WHERE datname=current_database()",
        );
        assert.equal(locales.rows[0].datcollversion, locales.rows[0].actual);
      } finally {
        client.release();
      }
    } finally {
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
);
