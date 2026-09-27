import { NextRequest, NextResponse } from "next/server";
import { createToken, maskToken, readTokens, revokeToken } from "@/lib/api-tokens";

// Owner-only: creating/listing/revoking API tokens requires the master
// APP_API_KEY specifically — a generated token can never be used to mint or
// revoke other tokens, only to call /api/chat.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function requireOwner(req: NextRequest): NextResponse | null {
  const appKey = process.env.APP_API_KEY;
  if (!appKey) return null; // no owner key configured -> open, matches rest of the app
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${appKey}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }
  return null;
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const denied = requireOwner(req);
  if (denied) return denied;

  try {
    const tokens = await readTokens();
    return NextResponse.json(
      {
        tokens: tokens.map((t) => ({
          id: t.id,
          label: t.label,
          createdAt: t.createdAt,
          masked: maskToken(t.token),
        })),
      },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read tokens" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}

export async function POST(req: NextRequest) {
  const denied = requireOwner(req);
  if (denied) return denied;

  let label = "";
  try {
    const body = await req.json();
    if (typeof body?.label === "string") label = body.label.slice(0, 100);
  } catch {
    // no body / not JSON is fine, label just stays "untitled"
  }

  try {
    const created = await createToken(label);
    // Full token value is returned ONLY here, at creation time.
    return NextResponse.json({ ...created }, { headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create token" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const denied = requireOwner(req);
  if (denied) return denied;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: "Provide the token id as ?id=" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  try {
    const revoked = await revokeToken(id);
    if (!revoked) {
      return NextResponse.json(
        { error: `No token with id "${id}"` },
        { status: 404, headers: CORS_HEADERS }
      );
    }
    return NextResponse.json({ revoked: id }, { headers: CORS_HEADERS });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to revoke token" },
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
