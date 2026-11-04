import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { checkAccess, publicOrigin, refusal } from "@/lib/auth";

// The Thun Murex extension for VS Code, for whoever can sign in to the console
// (the owner key, or an admin's account). It lives in extension/ and not in
// public/, which anyone could fetch. To publish a new version: `npm run package`
// in ai-thun-vscode, replace the .vsix in extension/ with the new one, and
// deploy. For the console's own page only: no CORS.

const FOLDER = path.join(process.cwd(), "extension");
const PACKAGE_FILE = /^ai-thun-(\d+)\.(\d+)\.(\d+)\.vsix$/;
const NO_STORE = { "Cache-Control": "no-store" };

// The highest version in the folder, should an old one be left behind.
async function latestPackage(): Promise<{ fileName: string; version: string } | null> {
  const names = await readdir(FOLDER).catch(() => [] as string[]);
  const versions = names.flatMap((fileName) => {
    const m = PACKAGE_FILE.exec(fileName);
    return m ? [{ fileName, parts: [Number(m[1]), Number(m[2]), Number(m[3])] }] : [];
  });
  versions.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
  const latest = versions[0];
  return latest ? { fileName: latest.fileName, version: latest.parts.join(".") } : null;
}

// GET /api/extension → {fileName, version, size, address}, `address` being the
// gateway's to give the extension. GET /api/extension?download=1 → the package.
export async function GET(req: NextRequest) {
  const access = await checkAccess(req, "owner");
  if (!access.ok) return refusal(access, NO_STORE);

  const latest = await latestPackage();
  if (!latest) {
    return NextResponse.json({ error: "The extension's package isn't on this server." }, { status: 404, headers: NO_STORE });
  }
  const file = path.join(FOLDER, latest.fileName);

  if (req.nextUrl.searchParams.has("download")) {
    return new NextResponse(await readFile(file), {
      headers: {
        ...NO_STORE,
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${latest.fileName}"`,
      },
    });
  }

  return NextResponse.json(
    { ...latest, size: (await stat(file)).size, address: publicOrigin() ?? req.nextUrl.origin },
    { headers: NO_STORE },
  );
}
