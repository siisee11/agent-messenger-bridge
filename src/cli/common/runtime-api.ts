import { request as httpRequest } from 'http';

export type RuntimeWindowInfo = {
  windowId: string;
  sessionName: string;
  windowName: string;
  status?: string;
  pid?: number;
};

export type RuntimeWindowsResponse = {
  activeWindowId?: string;
  windows: RuntimeWindowInfo[];
};

type RuntimeApiResponse = {
  status: number;
  body: string;
};

export async function runtimeApiRequest(params: {
  port: number;
  method: 'GET' | 'POST';
  path: string;
  payload?: unknown;
}): Promise<RuntimeApiResponse> {
  return await new Promise((resolve, reject) => {
    const body = params.payload === undefined ? '' : JSON.stringify(params.payload);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: params.port,
        path: params.path,
        method: params.method,
        headers: params.method === 'POST'
          ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          }
          : undefined,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: data });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('runtime api timeout')));
    if (params.method === 'POST') {
      req.write(body);
    }
    req.end();
  });
}

export async function listRuntimeWindows(port: number): Promise<RuntimeWindowsResponse | null> {
  try {
    const response = await runtimeApiRequest({
      port,
      method: 'GET',
      path: '/runtime/windows',
    });
    if (response.status !== 200) return null;
    const parsed = JSON.parse(response.body) as Partial<RuntimeWindowsResponse>;
    if (!Array.isArray(parsed.windows)) return null;
    const windows = parsed.windows.filter((item): item is RuntimeWindowInfo => {
      if (!item || typeof item !== 'object') return false;
      const value = item as Record<string, unknown>;
      return typeof value.windowId === 'string' && typeof value.sessionName === 'string' && typeof value.windowName === 'string';
    });
    return {
      activeWindowId: typeof parsed.activeWindowId === 'string' ? parsed.activeWindowId : undefined,
      windows,
    };
  } catch {
    return null;
  }
}

export async function focusRuntimeWindow(port: number, windowId: string): Promise<boolean> {
  try {
    const response = await runtimeApiRequest({
      port,
      method: 'POST',
      path: '/runtime/focus',
      payload: { windowId },
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

export async function stopRuntimeWindow(port: number, windowId: string): Promise<boolean> {
  try {
    const response = await runtimeApiRequest({
      port,
      method: 'POST',
      path: '/runtime/stop',
      payload: { windowId },
    });
    return response.status === 200;
  } catch {
    return false;
  }
}

export async function ensureRuntimeWindow(params: {
  port: number;
  projectName: string;
  instanceId?: string;
  permissionAllow?: boolean;
}): Promise<boolean> {
  try {
    const response = await runtimeApiRequest({
      port: params.port,
      method: 'POST',
      path: '/runtime/ensure',
      payload: {
        projectName: params.projectName,
        ...(params.instanceId ? { instanceId: params.instanceId } : {}),
        ...(params.permissionAllow ? { permissionAllow: true } : {}),
      },
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
