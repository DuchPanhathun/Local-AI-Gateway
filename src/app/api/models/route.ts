import { NextRequest, NextResponse } from "next/server";
import { defaultModel, listModels, PROVIDER_IDS } from "@/lib/ai-providers";
import { LOCAL_AGENT_PROVIDER_IDS, models as localAgentModels } from "@/lib/local-agent";
import { getProviderState } from "@/lib/provider-setup";
import { checkAccess, keyRule, refusal } from "@/lib/auth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

type LocalProviderModels = {
  installed?: boolean;
  default?: string | null;
  models?: { id: string; name: string }[];
  note?: string | null;
  error?: string | null;
};

// Every provider's selectable models in one response, and whether it's
// paused. Unlike quotas/health, generated tokens may call this too: it's
// discovery info for API callers, with no usage data or secrets in it. A
// token only sees the providers its key can use.
export async function GET(req: NextRequest) {
  const access = await checkAccess(req, "app");
  if (!access.ok) return refusal(access, CORS_HEADERS);

  const paused = new Set((await getProviderState()).paused);
  const [cloud, local] = await Promise.all([
    // A paused cloud provider isn't asked for its list at all.
    Promise.all(
      PROVIDER_IDS.map(async (id) => [id, paused.has(id) ? null : await listModels(id)] as const)
    ),
    localAgentModels().then(
      (r) => r,
      (err: unknown) => ({
        status: 502,
        data: { error: err instanceof Error ? err.message : "local-agent-gateway is unreachable" },
      })
    ),
  ]);

  const providers: Record<string, unknown> = {};
  for (const [id, list] of cloud) {
    const fallback = defaultModel(id);
    providers[id] = list
      ? { kind: "cloud", ...list, note: null, paused: false }
      : {
          kind: "cloud",
          default: fallback,
          models: [{ id: fallback, name: fallback }],
          note: null,
          error: null,
          paused: true,
        };
  }

  const localData = local.data as { providers?: Record<string, LocalProviderModels>; error?: string };
  const localError =
    local.status === 200 ? null : localData.error ?? `local-agent-gateway returned HTTP ${local.status}`;
  for (const id of LOCAL_AGENT_PROVIDER_IDS) {
    const p = localData.providers?.[id];
    providers[id] = {
      kind: "local",
      default: p?.default ?? null,
      models: p?.models ?? [],
      note: p?.note ?? null,
      error: p ? (p.error ?? (p.installed === false ? "CLI not installed" : null)) : localError,
      paused: paused.has(id),
    };
  }

  for (const id of Object.keys(providers)) {
    if (keyRule(access, id).refused) delete providers[id];
  }

  return NextResponse.json({ providers }, { headers: CORS_HEADERS });
}
