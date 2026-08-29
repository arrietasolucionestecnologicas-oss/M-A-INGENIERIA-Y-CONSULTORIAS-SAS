# APP GESTIÓN PRUEBAS MICHAEL — M&A Ingeniería y Consultoría SAS

App de campo para técnicos que hacen pruebas eléctricas a transformadores (TTR,
resistencia de devanados, aceite dieléctrico) siguiendo criterios tipo IEEE.
Pensada para usarse en exteriores, con conectividad inestable, en celular.

## Arquitectura activa (esta es la que corre en producción)

- **Frontend**: HTML/CSS/JS estático servido por **GitHub Pages** desde la raíz
  de este repo (`index.html`, `styles.css`, `app.js`). Sin build step, sin
  framework — todo vanilla JS en un solo `app.js`.
- **Backend**: Google Apps Script Web App (`backend-apps-script/Código.gs`),
  con Google Sheets como base de datos y Google Drive para archivos (fotos de
  placa, certificados de laboratorio, evidencias de prueba en PDF).
- **Autenticación**: NO tiene login propio. Valida cada request contra un IdP
  compartido ("Control de Acceso"), un proyecto de Apps Script **separado**
  que no vive en este repo — M&A es una de varias apps que confían en él
  (`APP_ID = "MYA_PRUEBAS"` en `app.js` / `Código.gs`). El token se valida en
  cada llamada vía `validateAuth_()`; `402` = servicio suspendido (billing),
  `403` = token inválido/expirado (fuerza logout, no muestra la pantalla de
  suspendido — son cosas distintas, ver `callApi()` en `app.js`).

Hay una **carpeta `src/` y archivos Gradle/Docker en la raíz** que son un
diseño de backend Kotlin+Ktor **anterior y ya no activo** (se evaluó antes de
decidirse por Apps Script). No los borres sin preguntar, pero no son la fuente
de verdad — si algo no cuadra entre ese código y lo que describe este archivo,
manda `Código.gs`.

## Jerarquía obligatoria de datos

```
Sitio (Cliente/Proyecto)  →  Transformador (equipo)  →  Prueba (TTR / Resistencia / Aceite)
```

- Un transformador **siempre** pertenece a un `site_id`. `createTransformer_`
  rechaza la creación si falta.
- El **número de serie es la clave física real** del equipo — nunca debe
  duplicarse. `checkSerialExists_()` en `app.js` busca por serie en TODOS los
  sitios (no solo el activo) antes de crear; si ya existe en el mismo
  cliente lo reabre, si existe en otro cliente bloquea y dice dónde está.
- La UI **no fuerza navegación de página en página** para completar la
  jerarquía: si el técnico intenta entrar a una prueba sin cliente/equipo
  seleccionado, aparece un **modal** pidiendo justo lo que falta
  (`openContextModal_()` en `app.js`), sin sacarlo de donde estaba. Las
  páginas completas de "Clientes/Proyectos" y "Equipos" también existen para
  navegación normal.

## Módulos de prueba

| Módulo | Estado | Motor de cálculo |
|---|---|---|
| TTR (relación de transformación) | ✅ Completo | `calculateTtr_` |
| Resistencia de devanados | ✅ Completo | `calculateWindingResistance_` |
| Aceite dieléctrico | ✅ Completo | `calculateOilAnalysis_` (matriz: acidez/tensión interfacial → regeneración; rigidez/humedad → termovacío; si no, aprobado) |
| Aislamiento (Megger, DAR/IP) | Backend listo (`calculateInsulation_`), **sin formulario en el frontend** | — |
| Análisis PCB (Bifenilos) | Solo placeholder — nav deshabilitado | Falta definir umbral regulatorio con el cliente antes de construirlo |

Cada envío de prueba acepta un adjunto opcional (`file_base64`/`file_mime_type`)
que sube a Drive vía `persistTest_()` — ya funciona para los tres módulos
completos, no hace falta tocar el backend para agregar evidencia a uno nuevo.

## RBAC

Roles vienen de Control de Acceso: `Administrador`, `Supervisor`, `Tecnico`.
El panel "Gestión de usuarios" y los botones de eliminar (sitio/equipo) **no
se agregan al DOM en absoluto** para roles que no son Administrador — no es
solo `display:none` (ver `renderAdminNavAndPanel`/`removeAdminNavAndPanel`).
`deleteTransformer`/`deleteSite` también lo validan en el backend
(`auth.role !== 'Administrador'`), no confíes solo en el frontend.

## Convenciones de frontend que hay que respetar

- **Nunca uses `parseFloat()` directo sobre un input de usuario** — trunca en
  la coma decimal (`"12,5"` → `12`) sin avisar. Usa `parseDecimal_()`. Todo
  campo numérico de lectura de campo es `type="text" inputmode="decimal"
  pattern="[0-9]*[.,]?[0-9]*"`, no `type="number"` (ese sí rechaza comas en
  varios navegadores/locales).
- **Caché-luego-red**: `loadSitesAndShow_`, `loadDashboardAndShow_`,
  `openTransformer`, `openContextModal_` muestran datos de `localStorage` de
  inmediato si existen (sensación instantánea) y siempre refrescan contra el
  backend después. Si agregas una lista nueva, sigue el mismo patrón
  (`saveDraft_`/`loadDraft_`/`clearDraft_` son genéricas pese al nombre — se
  reusan tanto para borradores de formulario como para este caché).
- **Resiliencia de red**: un fallo de `fetch()` nunca debe borrar lo que el
  técnico ya digitó. Los formularios de prueba guardan borrador en
  `localStorage` en cada cambio y solo lo limpian tras un envío exitoso.
  `formatNetworkAwareError_()` distingue "sin conexión" de un error de
  validación real.
- **Tema único claro** (sin dark mode) — paleta oficial del manual de marca
  M&A, ver el comentario al inicio de `styles.css` para los códigos hex y por
  qué el texto sobre rellenos sólidos es oscuro (`#152618`) y no blanco en
  casi todos los casos (se midió el contraste real, está documentado ahí).
  `--danger` NO es un color del manual de marca — no había rojo, se derivó.
- Botones/chips/inputs interactivos siguen el sistema de tokens (`--accent`,
  `--nav-bg`, etc. en `:root`) — no hardcodear colores nuevos.

## Desplegar cambios de backend (Código.gs)

Este repo tiene una **copia** de `Código.gs`, pero Apps Script no se despliega
por git push. El flujo real:

1. Editar `backend-apps-script/Código.gs` en este repo (commit normal).
2. Hace falta un **clon clasp** del proyecto de Apps Script (script ID
   `1Wbm_kEACu4Bjuc5tyH5xWMQaSgzorqbn7kiD2GoPX7dL1nbg8IzDoSeE`) — no vive en
   este repo. Si no existe uno local: `clasp clone 1Wbm_kEACu4Bjuc5tyH5xWMQaSgzorqbn7kiD2GoPX7dL1nbg8IzDoSeE`
   (requiere `clasp login` ya autorizado en esta máquina).
3. Copiar el `Código.gs` actualizado al `Código.js` del clon.
4. `npx clasp push --force`
5. `npx clasp deploy --deploymentId AKfycbz1frJeBe7KpN83DQaVjtPBfzWtdujl6mngBAmAe3XCLRBW6_5cEShkVPRwgk98UtbKAw --description "..."`

Sin el paso 4-5, el cambio queda solo en el repo — el Web App en vivo sigue
sirviendo la versión anterior.

## Verificación

No hay suite de tests automatizada. La verificación se ha hecho **en vivo**
contra el backend real desplegado, usando el navegador embebido de Claude
Code (`preview_start` con el nombre `frontend-static` de `.claude/launch.json`,
luego login real + llamadas de API desde la consola). Si `preview_start` con
ese nombre falla por conflicto de puerto/registro, puede hacer falta agregar
la entrada también al `.claude/launch.json` del directorio de trabajo
*primario* de la sesión (no necesariamente este repo) — es una rareza del
entorno, no un bug de la app.

Credenciales de prueba (usuario Administrador real, no lo pongas en ningún
archivo del repo): pedirlas al usuario directamente, no están guardadas aquí
a propósito.

## Estado / pendientes conocidos

No implementado todavía, evaluado pero no decidido con el usuario:
- Sesión persistente entre recargas (`sessionStorage`) — hoy el token vive
  solo en memoria JS, un refresh de página desloguea.
- `SweetAlert2` en vez de `alert()`/`confirm()` nativos.
- Flujo de borrador/certificado en dos etapas para pruebas (hoy todo envío
  queda como definitivo de inmediato).
- Migrar a offline real (service worker + IndexedDB) — hoy la resiliencia de
  red es "no perder lo digitado", no "funcionar sin señal".

Base de datos en vivo: limpia de datos de prueba a partir del 2026-08-26 (se
borraron todos los sitios/equipos creados durante verificación).
