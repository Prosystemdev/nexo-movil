# Nexo Movilidad — app del vendedor (v0.1.0)

App web instalable (PWA) para Android. Consulta artículos (precios, existencia exacta), clientes propios y facturas pendientes, **sin conexión**. Los datos los genera Nexo (v0.30.0 o superior) cifrados con AES-256-GCM y llegan por Dropbox.

Esta versión es de **consulta**; los pedidos vienen después.

## Archivos
`index.html`, `app.js`, `estilos.css`, `sw.js`, `manifest.webmanifest`, `config.js`, `icons/`. No tiene dependencias ni paso de compilación: se publica tal cual.
`pruebas/movil.js` prueba la app con el servidor Nexo real (`node pruebas/movil.js`, requiere Playwright).

## 1. Publicar en GitHub Pages (paso 3)
1. Entra a tu repositorio `nexo-movil` en github.com.
2. **Add file > Upload files**.
3. Arrastra **el contenido** de esta carpeta (index.html, app.js, estilos.css, sw.js, manifest.webmanifest, config.js y la carpeta `icons`), no la carpeta contenedora. Las carpetas se pueden arrastrar enteras.
4. **Commit changes**. En 1 o 2 minutos la app está en `https://TU-USUARIO.github.io/nexo-movil/`.
5. Para actualizar: sube los archivos nuevos con el mismo nombre (reemplazan). Si cambias archivos de la app, sube también `sw.js` (con la VERSION nueva) para que los teléfonos la renueven.

## 2. Registrar la app en Dropbox (una sola vez, la hace Prosystemdev)
1. Entra a https://www.dropbox.com/developers/apps con la cuenta de Prosystemdev y pulsa **Create app**.
2. **Scoped access**; tipo de acceso **Full Dropbox** (necesario para leer la carpeta que se comparte con el vendedor); nombre único, por ejemplo `NexoMovilidad-Prosystemdev`.
3. Pestaña **Permissions**: marca `files.metadata.read` y `files.content.read` y pulsa **Submit**.
4. Pestaña **Settings**: en **Redirect URIs** agrega exactamente la dirección de tu app, con la barra final (por ejemplo `https://TU-USUARIO.github.io/nexo-movil/`) y pulsa **Add**.
5. Copia la **App key** (no la App secret; esa no se usa ni se publica).
6. Edita `config.js`, pega la clave entre las comillas de `dropboxAppKey` y súbelo a GitHub (paso 3.5).
7. El estado «Development» de la app de Dropbox sirve para el piloto (hasta 500 usuarios). Para más de eso se solicita «Production».

## 3. Compartir la carpeta con cada vendedor
En la PC de Nexo, Dropbox de escritorio sincroniza la carpeta que elegiste en Configuración > Movilidad. Dentro, Nexo crea `nexo-movil/<id>/salida/`. Comparte **solo la carpeta de ese vendedor** (`nexo-movil/<id>`) con el correo de Dropbox del vendedor, con permiso de **solo ver**. El vendedor acepta la invitación (Agregar a mi Dropbox). Así cada vendedor solo puede leer su propio archivo.

## 4. Instalar y enlazar en el teléfono (paso 6)
1. Abre la dirección de la app en **Chrome** del Android. Menú (⋮) > **Instalar aplicación**.
2. Al abrirla: pega el **código de enlace** (en Nexo: Configuración > Empresa > Movilidad > Enlace) y elige un **PIN** de 4 a 8 números.
3. Ajustes > **Conectar con Dropbox**, inicia sesión y autoriza. La app descarga los datos.
4. Desde entonces consulta sin señal; al abrirla con señal sincroniza (botón «Sincronizar ahora»).

## Seguridad
- La clave de cifrado se guarda en el teléfono cifrada con el PIN; los datos descargados siguen cifrados y solo se descifran en memoria.
- Bloqueo automático a los 5 minutos sin uso.
- Si se pierde el teléfono: en Nexo, **Suspender** al vendedor (renueva su clave: no podrá leer datos nuevos) y quita su acceso a la carpeta en Dropbox.
- Si cambias o renuevas la clave en Nexo, el vendedor pega el código nuevo (Ajustes > Usar un código de enlace nuevo).
