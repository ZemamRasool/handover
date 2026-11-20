// Google Drive import (SPEC.md Milestone 4). The leaving employee connects their Drive
// (read-only), picks work files, and we copy their text into their knowledge base.
// We never browse Drive on our own: only files the person selects are imported.

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
  webViewLink: string | null;
}

export interface DriveApi {
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<string | null>; // refresh token
  list(refreshToken: string, search: string): Promise<DriveFile[]>;
  fetch(refreshToken: string, fileId: string): Promise<{ file: DriveFile; data: Buffer; kind: "text" | "pdf" | "docx" } | null>;
}

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const IMPORTABLE = [GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SLIDES, "application/pdf", DOCX, "text/plain", "text/markdown"];

export function createGoogleDrive(clientId: string, clientSecret: string): DriveApi {
  const accessToken = async (refreshToken: string) => {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string };
    if (!data.access_token) throw new Error("Google Drive access was removed. Please connect Drive again.");
    return data.access_token;
  };
  const get = async (token: string, url: string) => fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const meta = async (token: string, id: string): Promise<DriveFile | null> => {
    const res = await get(token, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,webViewLink&supportsAllDrives=true`);
    return res.ok ? ((await res.json()) as DriveFile) : null;
  };

  return {
    authorizeUrl(state, redirectUri) {
      const p = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "https://www.googleapis.com/auth/drive.readonly",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state,
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
    },

    async exchangeCode(code, redirectUri) {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
      });
      const data = (await res.json().catch(() => ({}))) as { refresh_token?: string };
      return data.refresh_token ?? null;
    },

    async list(refreshToken, search) {
      const token = await accessToken(refreshToken);
      const types = IMPORTABLE.map((t) => `mimeType='${t}'`).join(" or ");
      const name = search.trim() ? ` and name contains '${search.trim().replace(/['\\]/g, "")}'` : "";
      const q = `trashed=false and (${types})${name}`;
      const url = `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, pageSize: "50", orderBy: "modifiedTime desc", fields: "files(id,name,mimeType,modifiedTime,webViewLink)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" })}`;
      const res = await get(token, url);
      if (!res.ok) throw new Error(`Google Drive error ${res.status}`);
      return ((await res.json()) as { files: DriveFile[] }).files ?? [];
    },

    async fetch(refreshToken, fileId) {
      const token = await accessToken(refreshToken);
      const file = await meta(token, fileId);
      if (!file || !IMPORTABLE.includes(file.mimeType)) return null;
      const exportAs = file.mimeType === GOOGLE_DOC || file.mimeType === GOOGLE_SLIDES ? "text/plain" : file.mimeType === GOOGLE_SHEET ? "text/csv" : null;
      const url = exportAs
        ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportAs)}`
        : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
      const res = await get(token, url);
      if (!res.ok) throw new Error(`Couldn't download "${file.name}" (${res.status})`);
      const data = Buffer.from(await res.arrayBuffer());
      const kind = file.mimeType === "application/pdf" ? "pdf" : file.mimeType === DOCX ? "docx" : "text";
      return { file, data, kind };
    },
  };
}
