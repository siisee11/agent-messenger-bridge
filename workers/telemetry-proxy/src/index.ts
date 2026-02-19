interface Env {
  GA4_MEASUREMENT_ID: string;
  GA4_API_SECRET: string;
  ALLOWED_SOURCE?: string;
}

interface IncomingEvent {
  name?: unknown;
  params?: unknown;
}

interface IncomingPayload {
  source?: unknown;
  installId?: unknown;
  version?: unknown;
  platform?: unknown;
  runtime?: unknown;
  events?: unknown;
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function sanitizeName(input: unknown, fallback: string): string {
  const raw = typeof input === 'string' ? input.trim().toLowerCase() : '';
  const normalized = raw.replace(/[^a-z0-9_]/g, '_');
  const withPrefix = /^[a-z]/.test(normalized) ? normalized : `e_${normalized}`;
  const sliced = withPrefix.slice(0, 40).replace(/_+/g, '_');
  return sliced || fallback;
}

function sanitizeString(input: unknown, maxLength: number): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function sanitizeNumber(input: unknown): number | undefined {
  if (typeof input !== 'number' || !Number.isFinite(input)) return undefined;
  return Math.max(0, Math.min(Math.round(input), 1_000_000_000));
}

function sanitizeParams(input: unknown): Record<string, string | number> {
  if (!input || typeof input !== 'object') return {};
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const safeKey = sanitizeName(key, '');
    if (!safeKey) continue;

    const asNumber = sanitizeNumber(value);
    if (asNumber !== undefined) {
      result[safeKey] = asNumber;
      continue;
    }

    if (typeof value === 'boolean') {
      result[safeKey] = value ? 1 : 0;
      continue;
    }

    const asString = sanitizeString(value, 100);
    if (asString !== undefined) {
      result[safeKey] = asString;
    }
  }
  return result;
}

function buildGa4Events(
  events: IncomingEvent[],
  metadata: { source?: string; version?: string; platform?: string; runtime?: string },
): Array<{ name: string; params: Record<string, string | number> }> {
  const sessionId = Date.now();
  return events.map((event) => {
    const name = sanitizeName(event.name, 'cli_event');
    return {
      name,
      params: {
        source: metadata.source || 'discode-cli',
        cli_version: metadata.version || 'unknown',
        cli_platform: metadata.platform || 'unknown',
        cli_runtime: metadata.runtime || 'unknown',
        session_id: sessionId,
        engagement_time_msec: 1,
        ...sanitizeParams(event.params),
      },
    };
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    let payload: IncomingPayload;
    try {
      payload = (await request.json()) as IncomingPayload;
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }

    const source = sanitizeString(payload.source, 50) || 'discode-cli';
    const allowedSource = sanitizeString(env.ALLOWED_SOURCE, 50);
    if (allowedSource && source !== allowedSource) {
      return json({ error: 'forbidden_source' }, 403);
    }

    const installId = sanitizeString(payload.installId, 100);
    if (!installId) {
      return json({ error: 'install_id_required' }, 400);
    }

    if (!Array.isArray(payload.events) || payload.events.length === 0) {
      return json({ error: 'events_required' }, 400);
    }

    const normalizedEvents = payload.events
      .slice(0, 10)
      .map((event) => (event && typeof event === 'object' ? (event as IncomingEvent) : {}));

    const events = buildGa4Events(normalizedEvents, {
      source,
      version: sanitizeString(payload.version, 50),
      platform: sanitizeString(payload.platform, 20),
      runtime: sanitizeString(payload.runtime, 20),
    });

    const ga4Url = new URL('https://www.google-analytics.com/mp/collect');
    ga4Url.searchParams.set('measurement_id', env.GA4_MEASUREMENT_ID);
    ga4Url.searchParams.set('api_secret', env.GA4_API_SECRET);

    const response = await fetch(ga4Url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        client_id: installId,
        non_personalized_ads: true,
        events,
      }),
    });

    if (!response.ok) {
      return json({ error: 'ga4_forward_failed' }, 502);
    }

    return json({ ok: true, accepted: events.length }, 202);
  },
};
