/**
 * LangSmith-Proxy: api/langsmith/[...path].ts + api/langsmith/runs/[...slug].ts
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export const LANGSMITH_API_KEY = process.env.LANGSMITH_API_KEY;
export const LANGSMITH_ENDPOINT = (
  process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com'
).replace(/\/+$/, '');
export const LANGSMITH_WORKSPACE_ID = process.env.LANGSMITH_WORKSPACE_ID;

export function buildUpstreamQuery(req: VercelRequest): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === 'path' || key === 'segments' || key === 'slug') continue;
    if (value === undefined) continue;
    const parts = Array.isArray(value) ? value : [value];
    for (const part of parts) {
      if (part !== undefined) params.append(key, String(part));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

export async function proxyToLangSmith(
  req: VercelRequest,
  res: VercelResponse,
  downstream: string,
): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!LANGSMITH_API_KEY) {
    res.status(500).json({ error: 'LANGSMITH_API_KEY is not configured' });
    return;
  }

  const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  if (!allowedMethods.includes(req.method || '')) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const queryString = buildUpstreamQuery(req);
  const targetUrl = `${LANGSMITH_ENDPOINT}/${downstream}${queryString}`;

  const forwardHeaders: Record<string, string> = {
    'x-api-key': LANGSMITH_API_KEY,
  };

  const ct = req.headers['content-type'];
  if (ct) forwardHeaders['content-type'] = ct as string;
  else if (req.method !== 'GET' && req.method !== 'HEAD') {
    forwardHeaders['content-type'] = 'application/json';
  }

  if (req.headers['accept']) {
    forwardHeaders['accept'] = req.headers['accept'] as string;
  }

  const tenant =
    (req.headers['x-tenant-id'] as string | undefined) || LANGSMITH_WORKSPACE_ID;
  if (tenant) {
    forwardHeaders['x-tenant-id'] = tenant;
  }

  try {
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: forwardHeaders,
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.body !== undefined && req.body !== '') {
        const ctLower = (ct as string | undefined)?.toLowerCase() ?? '';
        if (ctLower.includes('multipart/form-data')) {
          if (Buffer.isBuffer(req.body)) {
            fetchOptions.body = req.body as unknown as BodyInit;
          } else if (typeof req.body === 'string') {
            fetchOptions.body = req.body;
          } else {
            fetchOptions.body = JSON.stringify(req.body);
          }
        } else if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
          fetchOptions.body = req.body as unknown as BodyInit;
        } else {
          fetchOptions.body = JSON.stringify(req.body);
        }
      }
    }

    const upstream = await fetch(targetUrl, fetchOptions);

    res.status(upstream.status);

    const contentType = upstream.headers.get('content-type');
    if (contentType) {
      res.setHeader('content-type', contentType);
    }

    const responseBody = await upstream.text();
    res.send(responseBody);
  } catch (err: unknown) {
    console.error('[langsmith-proxy]', err);
    res.status(502).json({
      error: 'Failed to reach LangSmith API',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
