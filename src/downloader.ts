import fs from "fs";
import path from "path";
import { createGunzip } from "zlib";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { getSdeDir, getDbPath, getMetadataPath, closeDatabase } from "./database.js";

const SDE_URL = "https://www.fuzzwork.co.uk/dump/latest-sqlite.db.gz";

export async function downloadSde(): Promise<string> {
  const sdeDir = getSdeDir();
  const dbPath = getDbPath();
  const gzPath = dbPath + ".gz";
  const metadataPath = getMetadataPath();

  fs.mkdirSync(sdeDir, { recursive: true });

  closeDatabase();

  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }

  const response = await fetch(SDE_URL);
  if (!response.ok) {
    throw new Error(`Failed to download SDE: ${response.status} ${response.statusText}`);
  }

  const fileStream = fs.createWriteStream(gzPath);
  const body = response.body;
  if (!body) throw new Error("No response body");

  await pipeline(Readable.fromWeb(body as any), fileStream);

  const gzInput = fs.createReadStream(gzPath);
  const dbOutput = fs.createWriteStream(dbPath);
  await pipeline(gzInput, createGunzip(), dbOutput);

  fs.unlinkSync(gzPath);

  const metadata = {
    downloadedAt: new Date().toISOString(),
    sourceUrl: SDE_URL,
    fileSize: fs.statSync(dbPath).size,
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

  const sizeMb = (metadata.fileSize / 1024 / 1024).toFixed(1);
  return `SDE downloaded successfully (${sizeMb} MB). Ready to use.`;
}
