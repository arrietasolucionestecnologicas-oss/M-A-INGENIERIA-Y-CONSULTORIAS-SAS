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
- **Sitio** tiene `nit` (validado con dígito de verificación DIAN, ver más
  abajo) y `ciudad`, ambos opcionales. **Transformador** tiene un bloque de
  "características de placa" — todas opcionales —: `manufacturer`,
  `vector_group`, `rated_power_kva`, `hv_nominal_voltage`,
  `lv_nominal_voltage`, `manufacture_year`, `cooling_type` (ONAN/ONAF),
  `impedance_percent`, `insulation_type`. Ambas entidades tienen edición real
  (`updateSite`/`updateTransformer`), no solo creación — modales `#editSiteModal`
  / `#editTransformerModal` en `index.html`, reusan la clase `.modal` genérica.
- **NIT (Colombia)**: `calcularDigitoVerificacionNit_()` implementa el
  algoritmo DIAN estándar (módulo 11, pesos fijos por posición) — existe
  **duplicado a propósito** en `Código.gs` y en `app.js` (el backend es la
  fuente de verdad que de verdad valida; el frontend solo da vista previa
  instantánea mientras se escribe). Si cambias el algoritmo, cámbialo en los
  dos lados. `normalizeNit_()` acepta el NIT con o sin el DV ya puesto —
  si no lo trae, lo calcula y lo agrega; si lo trae, lo valida.
- **Migraciones de esquema**: `HEADERS.SITIOS`/`HEADERS.TRANSFORMADORES` en
  `Código.gs` han crecido más de una vez. La regla es siempre agregar
  columnas **al final del arreglo**, nunca insertarlas entre columnas
  existentes — insertar en medio correría el índice de columna de TODAS las
  filas ya guardadas en Sheets. `ensureAllSheets_()` sincroniza la fila de
  encabezado de una hoja ya existente si el arreglo creció (no solo al crear
  la hoja por primera vez).

## Módulos de prueba

| Módulo | Estado | Motor de cálculo |
|---|---|---|
| TTR (relación de transformación) | ✅ Completo | `calculateTtr_` |
| Resistencia de devanados | ✅ Completo | `calculateWindingResistance_` |
| Aceite dieléctrico | ✅ Completo — **tres secciones activables por checkbox**, ver abajo | `calculateOilAnalysis_` |
| Resistencia de aislamiento (Megger, DAR/IP) | ✅ Completo | `calculateInsulation_` |

### Resistencia de aislamiento — parámetros reales de `calculateInsulation_`

El backend (`submitInsulationTest_`/`calculateInsulation_`) ya existía y no se
tocó — el frontend se construyó leyendo primero qué esperaba, en vez de
asumir. Dos cosas que **no** coinciden con lo que se pidió inicialmente para
el formulario, reportadas explícitamente:

- **Solo existen 3 lecturas por fase, no 4**: `r30sMegaohm`, `r60sMegaohm`,
  `r10minMegaohm`. "60 s" y "1 min" son la misma medición (60 segundos = 1
  minuto) — no hay un campo `r1minMegaohm` separado. El formulario captura
  una sola lectura a los 60 s/1 min, etiquetada como tal para que no se
  confunda con una cuarta lectura que el backend ignoraría.
- **La temperatura de devanado se guarda pero no se usa en el cálculo** —
  `calculateInsulation_` no la lee para nada, solo queda en
  `raw_readings_json` como dato de registro (igual que en Resistencia de
  devanados). Se captura una sola vez por envío (no por fase).

Fórmulas y umbrales (idénticos en `darRating_`/`ipRating_` de `Código.gs` y
su réplica en `app.js` — vista previa instantánea, el backend es la fuente
de verdad):
- `DAR = R(60s) / R(30s)` — < 1.0 MALO, < 1.25 CUESTIONABLE, < 1.6 BUENO, si
  no EXCELENTE.
- `IP = R(10min) / R(60s)` — < 1.0 MALO, < 2.0 CUESTIONABLE, < 4.0 BUENO, si
  no EXCELENTE.
- `overallVerdict`: si cualquier fase tiene DAR o IP en MALO → `RECHAZADO`;
  si no pero alguna está en CUESTIONABLE → `OBSERVADO`; si no, `APROBADO`.

Las fases usadas son las mismas de Resistencia de devanados
(`getPhaseKeys()`/`TTR_TO_WR_PHASE_MAP` reusados tal cual: `H1-H2`/`H2-H3`/
`H3-H1`, o solo `H1-H2` si el transformador es monofásico) — no hay concepto
de TAP aquí, es una sola lectura por fase por visita.

Cada envío de prueba acepta un adjunto opcional (`file_base64`/`file_mime_type`)
que sube a Drive vía `persistTest_()` — ya funciona para los tres módulos
completos, no hace falta tocar el backend para agregar evidencia a uno nuevo.

### Aceite dieléctrico — estructura por secciones

El formulario NO es un solo bloque de campos obligatorios: son **tres
secciones independientes**, cada una activada por un checkbox, y el envío
exige al menos una activa (`fisicoquimico_realizado` / `dga_realizado` /
`pcb_realizado`, las tres viajan siempre en `readings` como booleanos).

- **Fisicoquímico** — 7 ensayos ASTM (agua, rigidez dieléctrica, tensión
  interfacial, número ácido, densidad relativa, color ASTM D1500, examen
  visual). Es la única sección con la matriz de decisión original: acidez ≥
  0.15 mg KOH/g O tensión interfacial ≤ 24 dinas/cm → `REQUIERE
  REGENERACIÓN / CAMBIO`; si no, rigidez ≤ 30 kV O agua ≥ 35 ppm →
  `REQUIERE TERMOVACÍO`; si no, `APROBADO`.
- **DGA** (cromatografía de gases disueltos) — 9 gases en ppm (H2, O2, N2,
  CH4, CO, CO2, C2H2, C2H4, C2H6). Solo captura datos, **sin veredicto
  automático todavía** — nadie ha definido la matriz de interpretación.
- **PCB** (cromatografía) — 7 Aroclores en ppm; `total_pcb_ppm` se calcula
  sumándolos, y ≥ 50 ppm → `Contaminado — requiere manejo especial (Res.
  222 de 2011, MinAmbiente)`, si no → `No contaminado`.

**Convención de veredicto combinado**: si dos secciones con veredicto propio
están activas a la vez (Fisicoquímico y PCB — DGA nunca aporta veredicto),
`overallVerdict` (el que se guarda en la columna `verdict` y colorea el pill
del historial) es el **más severo de los dos**, no una concatenación de
texto. Severidad: 3 = crítico (`REQUIERE REGENERACIÓN / CAMBIO`,
`Contaminado...`), 2 = alerta (`REQUIERE TERMOVACÍO`), 1 = ok (`APROBADO`,
`No contaminado`). El desglose de **cada** sección activa (con su propio
veredicto) igual queda completo en `calculated_results.sections` para la
vista de detalle — `overallVerdict` es solo el resumen para el historial, no
reemplaza el detalle. Si ninguna sección activa tiene veredicto propio (por
ejemplo, solo DGA), `overallVerdict` cae en `REGISTRADO` (pill neutro).

Esta misma lógica está **duplicada intencionalmente** en `Código.gs`
(`calculateOilAnalysis_`) y `app.js` (`calculateOilPreview_`, para la vista
previa instantánea) — si cambias los umbrales o la prioridad, cámbialos en
los dos lados.

Regla de guardado: **una sección desactivada envía sus campos en `null`,
nunca en `0`** (`buildOilRequestBody()` en `app.js`) — un 0 real en número
ácido o en un Aroclor es un dato válido, no debe confundirse con "no
medido". Si agregas un campo nuevo a una sección existente, síguelo
metiendo dentro del `if (seccion_realizado) {...} else {...}` de esa
función, no lo dejes fuera.

**Corregido — causa raíz compartida (afectaba TTR, Resistencia y Aceite por
igual, más el editor de matriz de TAPs) + fuga de credenciales.** No era un
bug de los renderers de dictamen (`renderTtrPreview`, `renderWindingPreview`,
`renderOilPreview` siempre escribieron en el panel correcto); el problema
vivía en las funciones `refreshTtr()`, `refreshWinding()`, `refreshOil()` y
`refreshMatrixJson()` — cada una, además de actualizar su vista previa real,
tenía copiada y pegada la misma línea de andamiaje de desarrollo:

```js
if (el) el.innerHTML = syntaxHighlight(Object.assign({ action: '...', token: state.token }, build...RequestBody()));
```

Esa línea escribía, sin ninguna bandera que lo condicionara, el payload
completo del próximo POST — **incluido `state.token`, el token de sesión
activo** — dentro de un panel siempre visible (`#jsonOil`/`#jsonTtr`/
`#jsonWinding`/`#jsonMatrix`, con la etiqueta `POST submit...Test`) ubicado
justo debajo de la vista previa real; en mobile (`.test-grid` colapsa a 1
columna) esto se veía como "la vista previa se rompió y muestra JSON". No
era un modo debug detrás de una bandera: era código de desarrollo que nunca
se quitó antes de que la app llegara a producción, así que se colaba en
cualquier despliegue.

Se eliminaron por completo (no se ocultaron ni se gatearon detrás de un
flag): los cuatro paneles `.json-tabs`/`.json-preview` y sus hints ("Se
envían con POST ..."), las líneas que los alimentaban dentro de
`refreshTtr`/`refreshWinding`/`refreshOil`, y el código que quedó muerto tras
eso (`switchJsonTab`, `refreshMatrixJson`, `syntaxHighlight`, y la regla CSS
`.json-*`). Se decidió borrar en vez de gatear con una bandera porque no
hay ningún caso legítimo en el que este panel deba verse en pantalla —
para inspeccionar un payload en desarrollo está la consola del navegador
(`network`/`console`), que no queda expuesta a quien mire la pantalla del
técnico ni a una captura/grabación.

Este bug estuvo **en producción (GitHub Pages)** con el token visible en
pantalla mientras la corrección solo existía sin desplegar en este repo —
si vuelves a ver este panel en el sitio en vivo después de este commit,
lo primero que hay que revisar es si el deploy a Pages realmente se hizo
(push a `main`), no el código en sí.

## Navegación (8 módulos)

La barra lateral (`#mainnav` en `index.html`) y la hoja "Más" móvil
(`#moreActionSheet`) están agrupadas en 8 módulos, con encabezados
`.nav-label` marcando cada grupo:

1. **Clientes y Proyectos** — Sitios (`view-sites`).
2. **Equipos** — Transformadores (`view-dashboard`) + Detalle del equipo
   (`view-detail`).
3. **Pruebas** — TTR, Resistencia de devanados, Aceite dieléctrico,
   Resistencia de aislamiento (`ttr-form`/`winding-form`/`oil-form`/
   `insulation-form`) — accesible también desde la hoja "Nueva prueba"
   (`#testActionSheet`, FAB móvil).
4. **Comercial** — placeholder de navegación (`view-commercial`); Ofertas y
   Licitaciones se construye después.
5. **Calibraciones** — placeholder de navegación (`view-calibrations`).
6. **Documentos e Informes** — placeholder de navegación (`view-documents`).
7. **Panel General** — placeholder de navegación (`view-general-dashboard`).
8. **Administración** — Gestión de usuarios (`view-admin`, sin cambios en su
   lógica).

Los 4 placeholders (puntos 4-7) ya están protegidos por rol (ver RBAC abajo)
para que cuando se construya cada uno **no haga falta reabrir la
navegación** — solo reemplazar el contenido `<div class="empty-note">
Próximamente...</div>` de cada `view-*` por el formulario/panel real.
Calibraciones y Documentos e Informes son estáticos en `index.html` (todos
los roles tienen algún acceso); Comercial y Panel General se insertan por
JS (`renderRestrictedModuleNav_()`/`removeRestrictedModuleNav_()` en
`app.js`, mismo patrón que `renderAdminNavAndPanel`/
`removeAdminNavAndPanel` — anclados con `insertAdjacentElement('afterend')`
sobre `#navItemDocuments` en escritorio y `#moreSheetDocumentsItem` en
móvil) porque son "Sin acceso" para Técnico y no deben existir en el DOM
para ese rol.

## RBAC

Roles vienen de Control de Acceso: `Administrador`, `Supervisor`, `Tecnico`.
Matriz completa por módulo:

| Módulo | Técnico | Supervisor | Administrador |
|---|---|---|---|
| Clientes y Proyectos | Full | Full | Full |
| Equipos | Full | Full | Full |
| Pruebas | Full | Full | Full |
| Calibraciones | Solo lectura | Full | Full |
| Documentos e Informes | Solo subir — no lista/descarga lo de otros | Full | Full |
| Comercial | Sin acceso | Full | Full |
| Panel General | Sin acceso | Full | Full |
| Administración | Sin acceso | Sin acceso | Full |

**Frontend**: "Sin acceso" siempre significa que el nodo **no se agrega al
DOM en absoluto** para ese rol, nunca solo `display:none` — ver
`renderAdminNavAndPanel`/`removeAdminNavAndPanel` (Administración, sin
cambios) y `renderRestrictedModuleNav_`/`removeRestrictedModuleNav_`
(Comercial y Panel General, mismo patrón). El panel "Gestión de usuarios" y
los botones de eliminar (sitio/equipo) siguen esta regla igual que siempre.

**Backend**: `deleteTransformer_`/`deleteSite_` ya rechazan explícitamente
por rol (`auth.role !== 'Administrador'` → `403`), no confíes solo en el
frontend. **Pendiente, a propósito**: Calibraciones, Comercial y Panel
General todavía no tienen NINGUNA acción de backend (son puro placeholder de
navegación hoy — no hay nada que rechazar todavía). El caso que sí importa
es **Documentos e Informes**: cuando se construya la función real de
listado/descarga (hoy no existe — no confundir con los adjuntos de prueba
que ya sube `persistTest_()`, que no tienen esta restricción), **debe
rechazar en el backend si `auth.role === 'Tecnico'`** salvo que el técnico
esté pidiendo/subiendo su propio archivo, con el mismo patrón `if
(auth.role === 'Tecnico') return jsonResponse_({status:403, ...})` que ya
usan `deleteTransformer_`/`deleteSite_`. No se implementó todavía porque la
función en sí no existe — quedó anotado aquí para que no se olvide cuando
se construya.

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
- **Nunca renderices un payload crudo ni un token en una vista visible al
  usuario.** Esta regla existe porque ya pasó: `refreshTtr`/`refreshWinding`/
  `refreshOil`/`refreshMatrixJson` volcaban `Object.assign({ token:
  state.token }, build...RequestBody())` en un `<pre>` siempre visible (ver
  "Corregido" en Aceite dieléctrico arriba) — una fuga de credenciales de
  sesión en producción, no solo un problema estético. Si necesitas ver el
  payload exacto durante desarrollo, usa la pestaña Network/Console del
  navegador — nunca un elemento del DOM de la app. Si algún día hace falta un
  modo debug real, tiene que vivir detrás de una bandera explícita en `false`
  por defecto y nunca debe poder activarse en la build que corre en GitHub
  Pages; hoy no existe ninguna, a propósito.
- **Local-first + toast** (crear/editar Sitio y Equipo): el envío nunca espera
  al backend para actualizar la UI. `handleCreateSiteSubmit` /
  `handleEditSiteSubmit` / `handleCreateTransformerSubmit` /
  `handleEditTransformerSubmit` insertan o mezclan el registro en
  `state.sites`/`state.transformers` **de inmediato**, lo cachean
  (`saveDraft_`) y vuelven a pintar la tabla (`renderSites`/`renderDashboard`)
  antes de tocar la red — un alta usa un id temporal `tmp_<timestamp>_<rand>`
  hasta que el backend responde. El POST real corre después, en segundo
  plano:
  - Éxito → se refresca la lista completa (`listSites`/`listTransformers`)
    para reemplazar el id temporal por el real y sincronizar cualquier valor
    normalizado por el servidor (p. ej. el DV del NIT), y se muestra
    `showToast_(msg, 'success')`.
  - Fallo → el registro se marca `_pending:false, _error:true,
    _errorMessage`, guarda `_retryAction`/`_retryPayload` para reintentar sin
    pedir los datos de nuevo, y se muestra `showToast_(msg, 'error')`. La fila
    pinta un pill "Pendiente · reintentar" (`retryPendingSite_`/
    `retryPendingTransformer_`) en vez de los botones normales, y no es
    navegable mientras está pendiente o con id temporal — nada de lo que
    escribió el técnico se pierde.
  - `showToast_(message, type, duration?)` es el componente de aviso genérico
    (`.toast-stack`/`.toast` en `styles.css`) — no bloquea, no exige cerrarse,
    y **debe reusarse** para cualquier formulario nuevo que necesite este
    patrón en vez de crear otro mecanismo de aviso.
  - **No aplica** a los envíos de prueba (TTR/Resistencia/Aceite): ahí el
    veredicto calculado por el backend es el dato que el técnico necesita ver
    de inmediato, así que siguen siendo síncronos. La deduplicación de número
    de serie (`checkSerialExists_`) tampoco entra en el patrón — se queda
    bloqueante a propósito (lectura rápida, crítica para no duplicar un
    activo) y solo el POST de creación pasa a segundo plano después.
- **Sesión persistente en `sessionStorage`, nunca en memoria sola ni en
  `localStorage`**: al hacer login (o tras un cambio de contraseña forzado),
  `saveSession_()` guarda `{token, username, role, allowedApps}` en
  `sessionStorage` bajo la clave `mya_session` — sobrevive a un refresh de
  página pero muere al cerrar el navegador/pestaña (por diseño: no debe
  quedar guardado indefinidamente como el caché de listas, que sí usa
  `localStorage`). Al arrancar (`DOMContentLoaded`), si hay una sesión
  guardada se restaura directo sin pedir credenciales y se salta la pantalla
  de login. `showView('login')` es el único lugar que limpia la sesión
  (`clearSession_()`) — cubre tanto el botón "Cerrar sesión" (que solo hace
  `showView('login')`) como el logout forzado por un `403` en `callApi()`,
  así que un token inválido nunca queda guardado.
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
- `SweetAlert2` en vez de `alert()`/`confirm()` nativos.
- Flujo de borrador/certificado en dos etapas para pruebas (hoy todo envío
  queda como definitivo de inmediato).
- Migrar a offline real (service worker + IndexedDB) — hoy la resiliencia de
  red es "no perder lo digitado", no "funcionar sin señal".

Módulos en diseño, pendientes de validar alcance con el cliente **antes de
construir el contenido real** (no empezar sin luz verde explícita) — ya
tienen su entrada de navegación y protección por rol listas (ver
"Navegación" y "RBAC" arriba), solo falta reemplazar el placeholder
"Próximamente" por el formulario/panel real cuando se defina el alcance:
- **Comercial → Ofertas y Licitaciones** — funnel pendiente/aprobada/
  rechazada/cierre; no depende de que exista un Sitio.
- **Calibraciones** — catálogo de instrumentos propios de M&A con semáforo
  de vigencia, se cruza con `instrument_used` en las pruebas.
- **Documentos e Informes** — carpeta de Drive por Sitio, certificados
  automáticos + subida manual. Backend RBAC pendiente hasta que exista la
  función real (ver nota en "RBAC" arriba).
- **Panel General** — dashboard consolidado de todas las operaciones.

Ver conversación con Gerson para el detalle completo de campos y KPIs
propuestos — lo de arriba es solo el resumen de alcance, no el diseño final.

Base de datos en vivo: limpia de datos de prueba (última verificación
2026-08-29 tras habilitar NIT/ciudad, características de placa y el
rediseño de Aceite — todo lo creado durante esas pruebas se borró al
terminar).
