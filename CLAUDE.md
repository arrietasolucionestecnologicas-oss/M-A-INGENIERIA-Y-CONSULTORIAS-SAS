# APP GESTIÓN PRUEBAS MICHAEL — M&A Ingeniería y Consultoría SAS

App de campo para técnicos que hacen pruebas eléctricas a transformadores (TTR,
resistencia de devanados, aceite dieléctrico) siguiendo criterios tipo IEEE.
Pensada para usarse en exteriores, con conectividad inestable, en celular.

## Arquitectura activa (esta es la que corre en producción)

- **Frontend**: HTML/CSS/JS estático servido por **GitHub Pages** desde la raíz
  de este repo (`index.html`, `styles.css`, `app.js`). Sin build step, sin
  framework — todo vanilla JS en un solo `app.js`.
- **Backend**: Google Apps Script Web App (`backend-apps-script/Código.gs` +
  `backend-apps-script/appsscript.json`), con Google Sheets como base de
  datos y Google Drive para archivos (fotos de placa, certificados de
  laboratorio, evidencias de prueba en PDF, documentos — ver "Documentos e
  Informes" abajo).
- **Autenticación**: NO tiene login propio. Valida cada request contra un IdP
  compartido ("Control de Acceso"), un proyecto de Apps Script **separado**
  que no vive en este repo, **en una cuenta de Google distinta** de la del
  backend de M&A (ver "Infraestructura / cuentas" abajo) — M&A es una de
  varias apps que confían en él (`APP_ID = "MYA_PRUEBAS"` en `app.js` /
  `Código.gs`). El token se valida en cada llamada vía `validateAuth_()`;
  `402` = servicio suspendido (billing), `403` = token inválido/expirado
  (fuerza logout, no muestra la pantalla de suspendido — son cosas
  distintas, ver `callApi()` en `app.js`).

Hay una **carpeta `src/` y archivos Gradle/Docker en la raíz** que son un
diseño de backend Kotlin+Ktor **anterior y ya no activo** (se evaluó antes de
decidirse por Apps Script). No los borres sin preguntar, pero no son la fuente
de verdad — si algo no cuadra entre ese código y lo que describe este archivo,
manda `Código.gs`.

## Infraestructura / cuentas de Google

El backend de M&A (Apps Script + Sheets + Drive) vive en una **cuenta de
Gmail dedicada del cliente**, separada de la cuenta que aloja Control de
Acceso — no se expone el correo exacto aquí a propósito, pedirlo al usuario
si hace falta. **Control de Acceso NO vive en esta cuenta dedicada** y no se
migra — sigue en la cuenta de Arrieta Soluciones, y `CONTROL_ACCESO_URL` en
`app.js`/`Código.gs` no cambia por esto.

- **Script ID activo**: `1eFExIWyw9Av_0GXUbyad9uPEtAc5hL0LMk6BPQ96gdTtnCzjirqsqEN5`
  (cuenta dedicada). El script ID anterior,
  `1Wbm_kEACu4Bjuc5tyH5xWMQaSgzorqbn7kiD2GoPX7dL1nbg8IzDoSeE` (cuenta Arrieta
  Soluciones), **queda obsoleto** — no se borró (no había necesidad ni se
  pidió), pero ya no es la fuente de verdad ni recibe despliegues nuevos.
- **Deployment ID activo**: `AKfycbwhVAjRgkfyxFjjLM2-6wlfDuurzhS2HLW2A3gS_NKziW6fyMlXuXrwcTrjmp7oZG1Ufg`
  (URL en `API_WEBHOOK_URL` de `app.js`). El deployment anterior,
  `AKfycbz1frJeBe7KpN83DQaVjtPBfzWtdujl6mngBAmAe3XCLRBW6_5cEShkVPRwgk98UtbKAw`,
  queda obsoleto por la misma razón.
- **Reconstrucción desde cero, no transferencia**: no existe un mecanismo de
  Google para "mover" un proyecto de Apps Script entre cuentas personales
  manteniendo el mismo script ID — se creó un proyecto nuevo y se copió
  `Código.gs` tal cual. No hubo pérdida de datos porque la base en la cuenta
  vieja ya estaba vacía (última limpieza documentada abajo). La hoja de
  Sheets y la carpeta raíz de Drive también son nuevas, creadas por el
  propio código (`getSpreadsheet_()`/`getRootFolder_()`) la primera vez que
  se usaron contra la cuenta nueva — no se migró ni copió nada de la hoja
  vieja.
- **GitHub Pages (frontend) NO se migró** — el repo se queda en la cuenta
  personal del usuario por ahora; es una migración aparte, independiente,
  que se hará al final del proyecto. Lo único que cambió aquí es a qué
  backend apunta `API_WEBHOOK_URL`, no dónde vive el repo.
- **Gotcha de despliegue al crear un proyecto nuevo en una cuenta nueva**:
  `clasp deploy` (API) puede crear el deployment y dejarlo respondiendo
  `403 Forbidden` a peticiones anónimas aunque el manifiesto ya tenga
  `webapp: {access: "ANYONE_ANONYMOUS"}` correcto — ejecutar la función
  directo en el editor (Sheets/Drive/UrlFetchApp) funciona bien en ese
  estado, así que no es un problema de permisos OAuth generales, es
  específico del acceso público del Web App. La solución que funcionó: abrir
  el proyecto en el editor de Apps Script (con la cuenta ya logueada),
  **Implementar → Administrar implementaciones**, editar la implementación
  existente y volver a darle **Implementar** desde ahí (sin cambiar nada) —
  ese paso por UI completa una autorización que el despliegue por API/clasp
  no termina de dejar lista. Después de eso, el acceso anónimo funcionó de
  inmediato.
- El manifiesto (`appsscript.json`) necesita explícitamente
  `webapp.executeAs: "USER_DEPLOYING"`, `webapp.access: "ANYONE_ANONYMOUS"`
  y los `oauthScopes` (`spreadsheets`, `drive`, `script.external_request`) —
  un proyecto nuevo creado por `clasp create-script` no trae estos campos
  por defecto, hay que agregarlos a mano (ya están en el `appsscript.json`
  de este repo, cópialo tal cual a cualquier clon nuevo).

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
  `impedance_percent`, `insulation_type`, `numero_posiciones_tap`. Ambas
  entidades tienen edición real (`updateSite`/`updateTransformer`), no solo
  creación — modales `#editSiteModal` / `#editTransformerModal` en
  `index.html`, reusan la clase `.modal` genérica.
- **`numero_posiciones_tap`** (entero, opcional) gobierna `tap_config.numPositions`
  — si el técnico lo diligencia, `buildDefaultTapPositions_(nominalVoltage,
  numPositions)` en `app.js` genera esa cantidad de posiciones (la neutra se
  calcula como la del medio, `Math.ceil(n/2)`) en vez del default histórico
  de 5. Vacío = se mantiene el comportamiento actual (5 por defecto), tanto
  al crear como al editar — editar este campo en un equipo existente
  **regenera** `tap_config.positions` (conserva `nominalVoltage`/
  `stepPercentage` actuales), así que si el equipo tiene una matriz
  personalizada (`custom_tap_ratio_matrix`) hay que revisarla después. TTR
  (`tapPositions()`/chip selector) y Resistencia de Devanados
  (`addWrTap()`/límite de gaps) leen `tap_config.positions` en vivo, así que
  ambos módulos reflejan el cambio sin más que abrir el formulario de nuevo
  — no hace falta tocar nada en ninguno de los dos al agregar este campo.
  El backend (`Código.gs`) solo almacena y devuelve `numero_posiciones_tap`
  como columna plana (`HEADERS.TRANSFORMADORES`, al final del arreglo) — no
  recalcula `tap_config` él mismo, ese cálculo sigue siendo responsabilidad
  del frontend, igual que antes de este campo existir.
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
| Resistencia de devanados | ✅ Completo — **primario multi-TAP + secundario**, ver abajo | `calculateWindingResistance_` |
| Aceite dieléctrico | ✅ Completo — **tres secciones activables por checkbox**, ver abajo | `calculateOilAnalysis_` |
| Resistencia de aislamiento (Megger, DAR/IP) | ✅ Completo — **3 combinaciones de devanado**, ver abajo | `calculateInsulation_` |

**Corregido — TTR no pintaba nada al abrir el formulario.** `renderTapChips()`
y `renderPhaseEntries()` solo se llamaban desde dentro de `selectTap()` —
nunca al montar `view-ttr-form` la primera vez, así que `#tapChipRow` y
`#ttrPhaseEntries` podían aparecer vacíos hasta que el técnico interactuara
con algo que ya no estaba ahí para hacer clic. `showView()` ahora llama a
ambas explícitamente al mostrar `ttr-form`, además de lo que ya hacía
(`renderTtrFormContext`/`renderMatrixRows`/`refreshTtr`).

### Resistencia de devanados — primario (multi-TAP) + secundario

**Corregido — auditoría IEEE C57.12.90.** El formulario ya soportaba varios
TAPs del primario (`state.wr.readings` indexado por posición,
`addWrTap()`/`removeWrTap()` sin tope duro) pero **no capturaba el
secundario en absoluto** — confirmado al revisar el código antes de tocar
nada: `TTR_TO_WR_PHASE_MAP` traducía las claves compuestas de TTR
(`H1H2-X1X2`) a solo `H1-H2`, descartando el lado X por completo.

Estructura actual:
- **Primario** — fase-fase (`H1-H2`/`H2-H3`/`H3-H1`, o solo `H1-H2` en
  monofásico), una lectura por cada posición de TAP que el técnico agregue
  (`state.wr.readings[tapPosition]`), sin cambios respecto a antes.
- **Secundario** — fase-fase (`X1-X2`/`X2-X3`/`X3-X1`, mismo criterio de
  monofásico vía `getSecondaryPhaseKeys_()`), **una sola medición sin
  selector de TAP** (`state.wr.secondary`) — normalmente el secundario no
  tiene cambiador de tomas.
- Ambos viajan en el mismo `submitWindingResistanceTest`, en claves
  separadas: `readings.measurements` (array, primario, sin cambios) y
  `readings.secondary` (objeto `{windingTemperatureC, phases}`, nuevo).
  `readings.secondary` es opcional en el contrato del backend (si falta, no
  rompe pruebas viejas ni llamadas externas), pero el frontend siempre lo
  envía.

`computePhaseUnbalancePreview_(phases)` en `app.js` y `computePhaseUnbalance_(phases)`
en `Código.gs` son el **mismo cálculo de desbalance factorizado en una
función**, reusado tanto por cada TAP del primario como por el secundario —
no duplicado. `overallVerdict` en `calculateWindingResistance_` ahora exige
que el primario **y** el secundario (si vino) estén `APROBADO`; si
cualquiera de los dos falla, el conjunto es `RECHAZADO` — mismo criterio
binario que ya existía, solo que ahora contempla ambos devanados.

**Requirió cambio en `Código.gs`** (a diferencia de Aislamiento): el
desbalance del secundario necesitaba calcularse y entrar al veredicto
combinado, algo que solo el backend puede hacer de forma autoritativa —
desplegar con el flujo de clasp de siempre (ver "Desplegar cambios de
backend" abajo).

### Resistencia de aislamiento — parámetros reales de `calculateInsulation_`

El backend (`submitInsulationTest_`/`calculateInsulation_`) ya existía y no se
tocó (ni en esta corrección ni en la construcción original) — es
**genérico respecto a la clave de medición**: itera `Object.keys(readings.measurements)`
sin asumir qué representa cada clave, así que el frontend puede usar
cualquier etiqueta sin tocar `Código.gs`. Dos cosas que **no** coinciden con
lo que se pidió inicialmente para el formulario, reportadas explícitamente:

- **Solo existen 3 lecturas por combinación, no 4**: `r30sMegaohm`,
  `r60sMegaohm`, `r10minMegaohm`. "60 s" y "1 min" son la misma medición (60
  segundos = 1 minuto) — no hay un campo `r1minMegaohm` separado. El
  formulario captura una sola lectura a los 60 s/1 min, etiquetada como tal
  para que no se confunda con una cuarta lectura que el backend ignoraría.
- **La temperatura de devanado se guarda pero no se usa en el cálculo** —
  `calculateInsulation_` no la lee para nada, solo queda en
  `raw_readings_json` como dato de registro. Se captura una sola vez por
  envío (no por combinación).

Fórmulas y umbrales (idénticos en `darRating_`/`ipRating_` de `Código.gs` y
su réplica en `app.js` — vista previa instantánea, el backend es la fuente
de verdad):
- `DAR = R(60s) / R(30s)` — < 1.0 MALO, < 1.25 CUESTIONABLE, < 1.6 BUENO, si
  no EXCELENTE.
- `IP = R(10min) / R(60s)` — < 1.0 MALO, < 2.0 CUESTIONABLE, < 4.0 BUENO, si
  no EXCELENTE.
- `overallVerdict`: si cualquier combinación tiene DAR o IP en MALO →
  `RECHAZADO`; si no pero alguna está en CUESTIONABLE → `OBSERVADO`; si no,
  `APROBADO`.

**Corregido — estructura de medición equivocada (auditoría IEEE C57.12.90).**
La primera versión del formulario medía "por fase" (`H1-H2`/`H2-H3`/`H3-H1`,
reusando `getPhaseKeys()`/`TTR_TO_WR_PHASE_MAP` de Resistencia de devanados)
— heredado por error, no por ningún requisito del backend (que, como se
explica arriba, no le importa la clave). La estructura correcta según norma
son **3 combinaciones de devanado**, fijas siempre (no dependen de
monofásico/trifásico): `INSULATION_COMBINATIONS = ['AT-BT', 'AT-Tierra',
'BT-Tierra']` en `app.js`, cada una con sus propias 3 lecturas de tiempo y
su propio DAR/IP. `state.insulation.combinations` (antes `.phases`) y las
funciones `renderInsulationCombinationEntries()`/
`updateInsulationCombination_()` (antes con sufijo `Phase`) se renombraron
para no dejar el vestigio de "fase" en un módulo que no trata de fases.

Cada envío de prueba acepta un adjunto opcional (`file_base64`/`file_mime_type`)
que sube a Drive vía `persistTest_()` — ya funciona para los tres módulos
completos, no hace falta tocar el backend para agregar evidencia a uno nuevo.
Desde que se construyó Documentos e Informes (ver abajo), ese certificado ya
no cae en una carpeta plana: `persistTest_()` lo guarda en `[Cliente]/
Certificados de Pruebas/` y lo indexa en la hoja `DOCUMENTOS` (categoría
`CERTIFICADOS`) para que aparezca en el listado del módulo.

## Documentos e Informes

Módulo completo (dejó de ser placeholder). Reorganiza dónde vive todo en
Drive — antes de este cambio **no existía ninguna estructura de carpetas**:
una sola carpeta plana (`ATTACHMENTS_FOLDER_NAME = 'TMS_Adjuntos'`, ubicada
por nombre en todo Drive con `getOrCreateFolder_()`, sin ID persistido) donde
caían certificados de prueba y fotos de placa mezclados, distinguidos solo
por el prefijo del nombre de archivo. Los archivos que ya estaban ahí antes
de este cambio **no se migraron** — siguen accesibles por su `fileId`
guardado en Sheets (Drive resuelve por ID, no importa la carpeta), pero no
aparecen en el listado nuevo de Documentos (no se hizo backfill: la base
estaba prácticamente vacía desde la limpieza del 26 de agosto, no había
certificados reales que valiera la pena indexar retroactivamente). Las
**fotos de placa** (`createTransformer_`/`updateTransformer_`) siguen
guardándose en la carpeta plana vieja, a propósito — fuera de alcance de
este cambio, que solo pedía reorganizar certificados de prueba y documentos
del módulo Documentos.

### Estructura de carpetas en Drive

```
M&A Ingeniería y Consultoría SAS/          ← raíz del proyecto, ID en Propiedades del script
├── Calibraciones/                          ← nivel proyecto, no por cliente
├── [Cliente · Proyecto 1]/                 ← un Sitio = una carpeta (ver abajo)
│   ├── Certificados de Pruebas/            ← solo persistTest_() escribe aquí
│   ├── Ofertas y Contratos/                ← subida manual
│   └── Documentos Generales/               ← subida manual
└── [Cliente · Proyecto 2]/
    └── ...
```

**IDs persistidos, nunca se busca por nombre dos veces**: la carpeta raíz y
`Calibraciones/` guardan su ID en `PropertiesService.getScriptProperties()`
(`getRootFolder_()`/`getCalibracionesFolder_()`); las 4 carpetas de un Sitio
(cliente + sus 3 subcarpetas) se guardan como columnas nuevas en
`HEADERS.SITIOS` (`drive_client_folder_id`, `drive_certificados_folder_id`,
`drive_ofertas_folder_id`, `drive_documentos_folder_id`, al final del
arreglo). `ensureSiteFolders_(site)` es la única función que las crea — si
ya están las 4 en la fila, las devuelve sin tocar Drive; si falta cualquiera
(Sitio nuevo, o uno creado antes de este cambio), crea las que falten y las
persiste en ese momento. **Migración perezosa a propósito**: no hay un
script que recorra todos los Sitios existentes creándoles carpetas de una —
se crean la primera vez que un Sitio realmente necesita subir algo.
`Calibraciones/` es la excepción: como el módulo Calibraciones no está
construido, nada la dispara sola — hay una acción dedicada,
`ensureDriveStructure_` (solo Administrador), para crearla explícitamente
sin depender de que exista esa primera subida.

### Índice de documentos (hoja `DOCUMENTOS`)

Drive no permite listar/filtrar por cliente+tipo+fecha de forma barata sin
recorrer carpetas en cada consulta, así que hay una hoja `DOCUMENTOS`
(`id`, `site_id`, `category`, `file_name`, `file_id`, `mime_type`,
`uploaded_by`, `created_at`) que actúa de índice. `category` es
`CERTIFICADOS` (solo la escribe `persistTest_()`), `OFERTAS_CONTRATOS` o
`GENERALES` (solo subida manual vía `uploadDocument_` — ese endpoint
**rechaza explícitamente** `category: 'CERTIFICADOS'`, los certificados los
sube el sistema, nunca a mano).

### RBAC — caso real, ya implementado

A diferencia de Calibraciones/Comercial/Panel General (que siguen sin
ninguna acción de backend), Documentos e Informes **sí tiene la función
real**, así que el rechazo por rol documentado antes como "pendiente" ya
está hecho: `listDocuments_(params, auth)` devuelve `403` de una si
`auth.role === 'Tecnico'`, mismo patrón que `deleteTransformer_`/
`deleteSite_`. `uploadDocument_` **no** rechaza por rol — Técnico tiene
`Full` para subir, según la matriz. En el frontend, `renderDocumentsView_()`
ni siquiera arma el HTML de la sección de listado/filtro cuando
`state.role === 'Tecnico'` (no se agrega al DOM, mismo criterio que el resto
de "RBAC" abajo) — un Técnico solo ve el formulario de subida.

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
6. **Documentos e Informes** — módulo completo (`view-documents`), ver
   sección dedicada arriba. Ya no es placeholder.
7. **Panel General** — placeholder de navegación (`view-general-dashboard`).
8. **Administración** — Gestión de usuarios (`view-admin`, sin cambios en su
   lógica).

Comercial, Calibraciones y Panel General siguen como placeholder — ya están
protegidos por rol (ver RBAC abajo) para que cuando se construyan **no haga
falta reabrir la navegación** — solo reemplazar el contenido
`<div class="empty-note">Próximamente...</div>` de cada `view-*` por el
formulario/panel real. Calibraciones y Documentos e Informes son estáticos
en `index.html` (todos
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
frontend. **Documentos e Informes también** — `listDocuments_` rechaza con
`403` si `auth.role === 'Tecnico'`, mismo patrón (ver sección dedicada
arriba; ya no está pendiente). **Sigue pendiente, a propósito**:
Calibraciones, Comercial y Panel General todavía no tienen NINGUNA acción de
backend (son puro placeholder de navegación hoy — no hay nada que rechazar
todavía).

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
  - **Corregido**: `retryPendingTransformer_` reenviaba el `_retryPayload`
    guardado a ciegas, sin volver a comprobar el número de serie — si otro
    dispositivo había registrado esa serie mientras el equipo quedó
    pendiente, el reintento lo duplicaba. Ahora vuelve a correr
    `checkSerialExists_(payload.serial_number)` antes de reenviar; si
    encuentra un match con un `id` distinto al del registro pendiente, NO
    reenvía — lo marca `_error` con un mensaje explícito de conflicto y
    avisa por `showToast_`, igual que cualquier otro fallo de sincronización.
    Un reintento de **edición** que encuentra su propio id no cuenta como
    conflicto (es el mismo equipo con su serie sin cambios).
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

Este repo tiene una **copia** de `Código.gs` (y de `appsscript.json`), pero
Apps Script no se despliega por git push. El flujo real:

1. Editar `backend-apps-script/Código.gs` en este repo (commit normal).
2. Hace falta un **clon clasp** del proyecto de Apps Script (script ID
   `1eFExIWyw9Av_0GXUbyad9uPEtAc5hL0LMk6BPQ96gdTtnCzjirqsqEN5`, cuenta
   dedicada — ver "Infraestructura / cuentas" arriba) — no vive en este
   repo. Si no existe uno local: `clasp clone 1eFExIWyw9Av_0GXUbyad9uPEtAc5hL0LMk6BPQ96gdTtnCzjirqsqEN5`
   (requiere `clasp login` ya autorizado **contra la cuenta dedicada**, no
   la de Arrieta Soluciones — son cuentas distintas, ver arriba).
3. Copiar el `Código.gs` actualizado al `Código.js` del clon (y
   `appsscript.json` si cambió).
4. `npx clasp push --force`
5. `npx clasp deploy --deploymentId AKfycbwhVAjRgkfyxFjjLM2-6wlfDuurzhS2HLW2A3gS_NKziW6fyMlXuXrwcTrjmp7oZG1Ufg --description "..."`

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
  de vigencia, se cruza con `instrument_used` en las pruebas. La carpeta de
  Drive (`Calibraciones/` a nivel de proyecto) ya existe — ver "Documentos e
  Informes" arriba — pero nada la usa todavía.
- **Panel General** — dashboard consolidado de todas las operaciones.

(Documentos e Informes ya no está en esta lista — se construyó completo,
ver la sección dedicada arriba.)

Ver conversación con Gerson para el detalle completo de campos y KPIs
propuestos — lo de arriba es solo el resumen de alcance, no el diseño final.

Base de datos en vivo: **desde 2026-08-30 vive en la cuenta dedicada nueva**
(ver "Infraestructura / cuentas" arriba), creada desde cero — no es la misma
hoja de antes de la migración. Limpia de datos de prueba (última
verificación 2026-08-30 tras migrar y probar Sitio + Transformador + prueba
de Aislamiento con certificado real en Drive — todo lo creado durante esa
verificación se borró al terminar). La hoja/carpeta viejas (cuenta Arrieta
Soluciones) ya estaban vacías desde la limpieza de 2026-08-29 y quedaron
así, sin usarse desde la migración.
