export const FOLDER_FIRMAS_ID = '1fK_xLbkgN2fcANBmabajgZhA7Hhry1wY';
export const FOLDER_CONSTANCIAS_ID = '1WXKwjHBvDPosGtX9XLohkEq_tOk224Kv';
export const GOOGLE_DRIVE_ACCOUNT_EMAIL = 'cpem25oficial@gmail.com';

export interface DriveFileItem {
  id: string;
  name: string;
  mimeType?: string;
  webViewLink?: string;
  createdTime?: string;
  size?: string;
}

const APPS_SCRIPT_URL = (import.meta.env.VITE_GOOGLE_APPS_SCRIPT_URL || '').trim();
const NETLIFY_DRIVE_FUNCTION_URL = '/.netlify/functions/drive-upload';

/**
 * URLs auxiliares para visualizar archivos almacenados en Google Drive
 */
export function getDriveThumbnailUrl(fileId: string, size = 800): string {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size}`;
}

export function getDrivePreviewUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/preview`;
}

export function getDriveDownloadUrl(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

/**
 * Comprime una imagen usando Canvas:
 * - Redimensiona a máximo 1000px de ancho manteniendo proporción
 * - Calidad 0.98
 * - Si es PDF, se retorna idéntico sin alterarlo
 */
export async function processFileForUpload(
  fileOrDataUrl: File | { dataUrl: string; name: string; type?: string }
): Promise<{ dataUrl: string; name: string; mimeType: string; isCompressed: boolean }> {
  if (fileOrDataUrl instanceof File) {
    const isPdf =
      fileOrDataUrl.type === 'application/pdf' ||
      fileOrDataUrl.name.toLowerCase().endsWith('.pdf');
    if (isPdf) {
      const dataUrl = await fileToDataUrl(fileOrDataUrl);
      return {
        dataUrl,
        name: fileOrDataUrl.name,
        mimeType: 'application/pdf',
        isCompressed: false,
      };
    }

    const rawDataUrl = await fileToDataUrl(fileOrDataUrl);
    const compressed = await compressImageWithCanvas(rawDataUrl, 1000, 0.98);
    const baseName = fileOrDataUrl.name.replace(/\.[^/.]+$/, '');
    return {
      dataUrl: compressed,
      name: `${baseName}.jpg`,
      mimeType: 'image/jpeg',
      isCompressed: true,
    };
  }

  const isPdf =
    fileOrDataUrl.type === 'application/pdf' ||
    fileOrDataUrl.name.toLowerCase().endsWith('.pdf');
  if (isPdf) {
    return {
      dataUrl: fileOrDataUrl.dataUrl,
      name: fileOrDataUrl.name,
      mimeType: 'application/pdf',
      isCompressed: false,
    };
  }

  const compressed = await compressImageWithCanvas(fileOrDataUrl.dataUrl, 1000, 0.98);
  const baseName = fileOrDataUrl.name.replace(/\.[^/.]+$/, '');
  return {
    dataUrl: compressed,
    name: `${baseName}.jpg`,
    mimeType: 'image/jpeg',
    isCompressed: true,
  };
}

/**
 * Redimensiona imagen a ancho máx 1000px con proporción y calidad 0.98
 */
export function compressImageWithCanvas(
  dataUrl: string,
  maxWidth = 1000,
  quality = 0.98
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        const ratio = maxWidth / width;
        width = maxWidth;
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(dataUrl);
        return;
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);

      const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve(compressedDataUrl);
    };
    img.onerror = (err) => {
      console.warn('No se pudo comprimir la imagen en Canvas, usando original', err);
      resolve(dataUrl);
    };
    img.src = dataUrl;
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) {
    return { mimeType: 'application/octet-stream', base64Data: dataUrl };
  }
  const header = dataUrl.slice(0, commaIdx);
  const mimeType = header.match(/:(.*?);/)?.[1] || 'application/octet-stream';
  const base64Data = dataUrl.slice(commaIdx + 1);
  return { mimeType, base64Data };
}

async function invokeDriveEndpoint(payload: Record<string, unknown>): Promise<any> {
  // 1. Prioridad: Google Apps Script Web App institucional (cpem25oficial@gmail.com)
  if (APPS_SCRIPT_URL) {
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: {
        // text/plain evita CORS preflight OPTIONS con Google Apps Script
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Respuesta inválida del endpoint de Google Drive: ${text.slice(0, 150)}`);
    }

    if (!res.ok || parsed?.error) {
      throw new Error(parsed?.error || `Error al comunicarse con Google Drive (${res.status})`);
    }

    return parsed;
  }

  // 2. Endpoint Serverless en Netlify (/.netlify/functions/drive-upload)
  const res = await fetch(NETLIFY_DRIVE_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Endpoint de Google Drive no disponible (${res.status}).`);
  }

  if (!res.ok || parsed?.error) {
    throw new Error(parsed?.error || `Error en subida directa a Google Drive (${res.status})`);
  }

  return parsed;
}

/**
 * Sube un archivo DIRECTAMENTE e inmediatamente a la carpeta de Google Drive especificada
 * en cuanto el agente lo envía, sin botones de conexión ni sincronización diferida.
 */
export async function uploadFileToDrive(options: {
  name: string;
  dataUrl: string;
  folderId: string;
}): Promise<{ fileId: string; webViewLink: string; name: string } | null> {
  const { mimeType, base64Data } = parseDataUrl(options.dataUrl);

  const data = await invokeDriveEndpoint({
    action: 'upload',
    folderId: options.folderId,
    fileName: options.name,
    mimeType,
    base64Data,
  });

  if (!data?.fileId) {
    throw new Error('No se recibió confirmación del archivo creado en Google Drive.');
  }

  return {
    fileId: data.fileId,
    webViewLink: data.webViewLink || `https://drive.google.com/file/d/${data.fileId}/view`,
    name: data.name || options.name,
  };
}

/**
 * Consulta la lista de archivos reales alojados en una carpeta de Google Drive
 */
export async function listFilesInDriveFolder(folderId: string): Promise<DriveFileItem[]> {
  try {
    const data = await invokeDriveEndpoint({
      action: 'list',
      folderId,
    });

    return (data?.files || []).map((f: any) => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      webViewLink: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
      createdTime: f.createdTime,
      size: f.size,
    }));
  } catch (err) {
    console.warn('Error listando archivos de Google Drive:', err);
    return [];
  }
}

/**
 * Elimina un archivo de Google Drive por su fileId (para Superadmin)
 */
export async function deleteFileFromDrive(fileId: string): Promise<boolean> {
  try {
    const data = await invokeDriveEndpoint({
      action: 'delete',
      fileId,
    });
    return !!data?.success;
  } catch (err) {
    console.warn('Error eliminando archivo de Google Drive:', err);
    return false;
  }
}
