import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export async function pickFolder(title = "Chọn thư mục", initialDir = "") {
  return pickWindows({ title, folder: true, initialDir });
}

export async function pickTextFile(title = "Chọn file caption hoặc comment", initialDir = "") {
  return pickWindows({ title, folder: false, initialDir });
}

function psQuote(value) {
  return String(value || "").replace(/[\r\n]/g, " ").replace(/'/g, "''");
}

function existingDir(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (fs.existsSync(text) && fs.statSync(text).isDirectory()) return path.resolve(text);
  const parent = path.dirname(text);
  if (parent && fs.existsSync(parent) && fs.statSync(parent).isDirectory()) return path.resolve(parent);
  return "";
}

async function pickWindows({ title, folder, initialDir }) {
  if (process.platform !== "win32") throw new Error("Hộp chọn file chỉ mở trên Windows. Gõ đường dẫn.");
  const safeTitle = psQuote(title || "Chọn");
  const start = psQuote(existingDir(initialDir));
  const ps = folder
    ? [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
      `$d.Description = '${safeTitle}'`,
      "$d.ShowNewFolderButton = $true",
      `$start = '${start}'`,
      "if ($start -and (Test-Path -LiteralPath $start -PathType Container)) { $d.SelectedPath = $start }",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.TopMost = $true",
      "$r = $d.ShowDialog($owner)",
      "$owner.Dispose()",
      "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
    ].join("; ")
    : [
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "$f = New-Object System.Windows.Forms.OpenFileDialog",
      `$f.Title = '${safeTitle}'`,
      "$f.Filter = 'Text và CSV|*.txt;*.csv|Tất cả|*.*'",
      "$f.CheckFileExists = $true",
      `$start = '${start}'`,
      "if ($start -and (Test-Path -LiteralPath $start -PathType Container)) { $f.InitialDirectory = $start }",
      "$r = $f.ShowDialog()",
      "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }",
    ].join("; ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-STA", "-Command", ps],
    { windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 }
  );
  const picked = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (!picked || !fs.existsSync(picked)) return "";
  return path.resolve(picked);
}
