import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function projectDir() {
  return projectRoot;
}

/** Data lives beside the source when developing, and in the folder Electron sets when packaged. */
export function homeDir() {
  const dir = process.env.FB_DANGBAI_HOME
    ? path.resolve(process.env.FB_DANGBAI_HOME)
    : path.join(projectRoot, "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function databasePath() {
  return path.join(homeDir(), "app.db");
}
