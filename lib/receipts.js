"use strict";
// Immutable receipt store. One JSON file per mutation event, never rewritten.
//
// A receipt is the only durable record that a mutation happened, what the world
// looked like immediately before it, and what the server actually returned on
// readback. Rollback reads nothing else. Files are written read-only so an
// accidental later write fails loudly instead of quietly rewriting history.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { canonical, hashValue, FactoryError } = require("./util");

function receiptsDir(root) { return path.join(root, "receipts"); }

function newId(kind) {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  return `${kind}-${ts}-${crypto.randomBytes(3).toString("hex")}`;
}

function write(root, receipt) {
  const dir = receiptsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const body = { ...receipt };
  body.contentHash = hashValue({ ...body, contentHash: undefined });
  const file = path.join(dir, `${receipt.id}.json`);
  if (fs.existsSync(file)) throw new FactoryError(`receipt ${receipt.id} already exists; receipts are immutable`);
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n", { mode: 0o444 });
  return { file, receipt: body };
}

function read(root, id) {
  const file = path.join(receiptsDir(root), `${id}.json`);
  if (!fs.existsSync(file)) throw new FactoryError(`no receipt ${id}`);
  const body = JSON.parse(fs.readFileSync(file, "utf8"));
  const expected = hashValue({ ...body, contentHash: undefined });
  if (body.contentHash !== expected) {
    throw new FactoryError(`receipt ${id} has been modified since it was written`, {
      recorded: body.contentHash, actual: expected,
    });
  }
  return body;
}

function list(root) {
  const dir = receiptsDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

module.exports = { newId, write, read, list, receiptsDir, canonical };
