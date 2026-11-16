import crypto from 'node:crypto';

interface DrivePayload {
  action?: 'upload' | 'list' | 'delete';
  folderId?: string;
  fileName?: string;
  mimeType?: string;
  base64Data?: string;
  fileId?: string;
}

const ALLOWED_FOLDERS = new Set([
  '1fK_xLbkgN2fcANBmabajgZhA7Hhry1wY', // Firmas
  '1WXKwjHBvDPosGtX9XLohkEq_tOk224Kv', // Constancias
]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function getGoogleAccessToken(): Promise<string> {
  // Opción 1: OAuth2 Refresh Token de cpem25oficial@gmail.com (recomendado para cuentas @gmail.com)
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const tokenData: any = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(
        `Error renovando token OAuth de Google Drive: ${tokenData.error_description || tokenData.error || tokenRes.statusText}`
      );
    }
    return tokenData.access_token;
  }

  // Opción 2: Service Account JSON (para Shared Drives / Google Workspace)
  const saRaw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (saRaw) {
    const sa = JSON.parse(saRaw);
    const now = Math.floor(Date.now() / 1000);
    const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64UrlEncode(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/drive',
        aud: 'https://oauth2.googleapis.com/token',
        exp: now + 3600,
        iat: now,
      })
    );

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${claim}`);
    sign.end();
    const signature = base64UrlEncode(sign.sign(sa.private_key));
    const jwt = `${header}.${claim}.${signature}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
    });

    const tokenData: any = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      throw new Error(
        `Error autenticando Service Account de Google Drive: ${tokenData.error_description || tokenData.error || tokenRes.statusText}`
      );
    }
    return tokenData.access_token;
  }

  throw new Error(
    'Falta configurar el enlace de Google Apps Script (VITE_GOOGLE_APPS_SCRIPT_URL) o las credenciales OAuth/Service Account de Google Drive en Netlify.'
  );
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return jsonResponse({ ok: true }, 204);
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Método no permitido' }, 405);
  }

  try {
    const payload = (await req.json()) as DrivePayload;
    const action = payload.action || 'upload';
    const accessToken = await getGoogleAccessToken();

    if (action === 'upload') {
      const { folderId, fileName, mimeType, base64Data } = payload;
      if (!folderId || !ALLOWED_FOLDERS.has(folderId)) {
        return jsonResponse({ error: 'Carpeta de Google Drive no autorizada.' }, 400);
      }
      if (!fileName || !base64Data) {
        return jsonResponse({ error: 'Nombre de archivo y contenido son requeridos.' }, 400);
      }

      const boundary = `cpem25_boundary_${Date.now()}`;
      const metadataPart = JSON.stringify({
        name: fileName,
        parents: [folderId],
        mimeType: mimeType || 'application/octet-stream',
      });

      const fileBuffer = Buffer.from(base64Data, 'base64');
      const bodyPrefix = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataPart}\r\n--${boundary}\r\nContent-Type: ${
          mimeType || 'application/octet-stream'
        }\r\n\r\n`,
        'utf-8'
      );
      const bodySuffix = Buffer.from(`\r\n--${boundary}--`, 'utf-8');
      const multipartBody = Buffer.concat([bodyPrefix, fileBuffer, bodySuffix]);

      const uploadRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink,webContentLink',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body: multipartBody,
        }
      );

      const uploadData: any = await uploadRes.json();
      if (!uploadRes.ok) {
        throw new Error(uploadData?.error?.message || uploadRes.statusText);
      }

      return jsonResponse({
        fileId: uploadData.id,
        name: uploadData.name,
        webViewLink: uploadData.webViewLink || `https://drive.google.com/file/d/${uploadData.id}/view`,
      });
    }

    if (action === 'list') {
      const { folderId } = payload;
      if (!folderId || !ALLOWED_FOLDERS.has(folderId)) {
        return jsonResponse({ error: 'Carpeta de Google Drive no autorizada.' }, 400);
      }
      const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
      const listRes = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${query}&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,webViewLink,createdTime,size)&pageSize=100&orderBy=createdTime desc`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      const listData: any = await listRes.json();
      if (!listRes.ok) {
        throw new Error(listData?.error?.message || listRes.statusText);
      }

      const files = (listData.files || []).map((f: any) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        webViewLink: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
        createdTime: f.createdTime,
        size: f.size ? `${(parseInt(f.size, 10) / 1024).toFixed(1)} KB` : undefined,
      }));

      return jsonResponse({ files });
    }

    if (action === 'delete') {
      const { fileId } = payload;
      if (!fileId) {
        return jsonResponse({ error: 'fileId requerido.' }, 400);
      }
      const delRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      return jsonResponse({ success: delRes.ok });
    }

    return jsonResponse({ error: 'Acción no soportada.' }, 400);
  } catch (err: any) {
    console.error('Error en drive-upload function:', err);
    return jsonResponse({ error: err?.message || 'Error interno subiendo a Google Drive.' }, 500);
  }
}
