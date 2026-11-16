/**
 * Google Apps Script para subida inmediata a Google Drive (CPEM N° 25)
 *
 * INSTRUCCIONES DE DESPLIEGUE (1 sola vez con la cuenta cpem25oficial@gmail.com):
 * 1. Ingresar a https://script.google.com con la cuenta cpem25oficial@gmail.com
 * 2. Crear un "Nuevo proyecto" y pegar todo este código.
 * 3. Hacer clic en "Implementar" -> "Nueva implementación".
 * 4. Tipo: "Aplicación web" (Web app).
 * 5. Ejecutar como: "Yo (cpem25oficial@gmail.com)".
 * 6. Quién tiene acceso: "Cualquier usuario" (Anyone).
 * 7. Copiar la URL de la aplicación web generada y configurarla en Netlify como
 *    variable de entorno: VITE_GOOGLE_APPS_SCRIPT_URL
 */

var ALLOWED_FOLDERS = {
  '1fK_xLbkgN2fcANBmabajgZhA7Hhry1wY': true, // Carpeta Firmas
  '1WXKwjHBvDPosGtX9XLohkEq_tOk224Kv': true  // Carpeta Constancias
};

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents || '{}');
    var action = payload.action || 'upload';

    if (action === 'upload') {
      var folderId = payload.folderId;
      if (!ALLOWED_FOLDERS[folderId]) {
        return jsonOut({ error: 'Carpeta de Google Drive no autorizada.' });
      }

      var folder = DriveApp.getFolderById(folderId);
      var bytes = Utilities.base64Decode(payload.base64Data);
      var blob = Utilities.newBlob(
        bytes,
        payload.mimeType || 'application/octet-stream',
        payload.fileName || 'archivo'
      );
      var file = folder.createFile(blob);

      return jsonOut({
        fileId: file.getId(),
        name: file.getName(),
        webViewLink: file.getUrl()
      });
    }

    if (action === 'list') {
      var listFolderId = payload.folderId;
      if (!ALLOWED_FOLDERS[listFolderId]) {
        return jsonOut({ error: 'Carpeta de Google Drive no autorizada.' });
      }

      var targetFolder = DriveApp.getFolderById(listFolderId);
      var iterator = targetFolder.getFiles();
      var files = [];
      while (iterator.hasNext() && files.length < 100) {
        var f = iterator.next();
        if (f.isTrashed()) continue;
        files.push({
          id: f.getId(),
          name: f.getName(),
          mimeType: f.getMimeType(),
          webViewLink: f.getUrl(),
          createdTime: f.getDateCreated().toISOString(),
          size: (f.getSize() / 1024).toFixed(1) + ' KB'
        });
      }
      files.sort(function(a, b) {
        return a.createdTime < b.createdTime ? 1 : -1;
      });
      return jsonOut({ files: files });
    }

    if (action === 'delete') {
      if (!payload.fileId) return jsonOut({ error: 'fileId requerido.' });
      DriveApp.getFileById(payload.fileId).setTrashed(true);
      return jsonOut({ success: true });
    }

    return jsonOut({ error: 'Acción no reconocida.' });
  } catch (err) {
    return jsonOut({ error: err.message || String(err) });
  }
}
