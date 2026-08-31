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
- **`estado_equipo`** (Transformador): `Activo` / `Fuera de servicio` / `Dado
  de baja` — semáforo operativo del equipo, no una característica de placa.
  Reutiliza una columna `status` que ya existía en `HEADERS.TRANSFORMADORES`
  (siempre fija en `'ACTIVO'`, sin control de edición real en la UI) en vez
  de agregar una columna paralela — se renombró en el mismo índice
  (`normalizeEstadoEquipo_`/`ESTADO_EQUIPO_VALUES` en `Código.gs`), así que
  no hubo migración de datos, solo un rename seguro (el único efecto es
  cosmético: la celda de encabezado en Sheets sigue diciendo "status" salvo
  que el arreglo vuelva a crecer). Migración perezosa: cualquier fila vieja
  con `'ACTIVO'` (mayúsculas, valor legado) o vacía se normaliza como
  `Activo` al leer. Por defecto `Activo` en equipos nuevos
  (`createTransformer_`); editable desde `#editTransformerModal`
  (`updateTransformer_` valida contra los 3 valores permitidos, rechaza
  cualquier otro con 400). Se muestra como badge en la lista de Equipos
  (`renderDashboard`) y en el detalle (`renderDetail` → `detailStatusChip`).
  Alimenta el KPI "Transformadores activos" de Panel General (ver abajo).
  Verificado en vivo: crear equipo → `Activo` por defecto; editar a `Fuera
  de servicio` desde el modal real → badge de lista y detalle se actualizan,
  el cambio persiste en el backend (confirmado con `getTransformer` tras el
  guardado), y el KPI de Panel General baja de 1 a 0 y vuelve a subir a 1 al
  revertir.
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
(`renderTtrFormContext`/`renderMatrixRows`/`refreshTtr`). **Verificado en
vivo (2026-08-30)**: los 5 chips TAP aparecen llenos de inmediato al abrir
el formulario por primera vez, sin interactuar con nada antes.

### TTR — la vista previa nunca calculaba el teórico para un equipo estándar

**Corregido (2026-08-30), bug distinto al de arriba (ese era de renderizado;
este es de cálculo).** El backend (`calculateTtr_` en `Código.gs`) siempre
calculó bien el valor teórico — voltaje del TAP (`tap_config.positions[].voltage`)
÷ `lv_nominal_voltage`, ajustado por el multiplicador de `vector_group`
(`VECTOR_GROUP_MULTIPLIERS`, factor √3 para grupos Dyn). El problema estaba
solo en el frontend: `computeTtrPreview()` — la función que alimenta el
panel "Vista previa del cálculo" que ve el técnico mientras mide — **nunca
implementó esa fórmula**. Solo leía `state.matrix.taps` (el editor de
`custom_tap_ratio_matrix`, pensado únicamente para equipos de diseño
especial), que para cualquier transformador estándar arranca en
`theoreticalRatio: 0` (`resetMatrixStateFromTransformer()`) y nunca se
llena con nada más. Resultado: la vista previa mostraba "teórico 0.000" /
estado "pendiente" siempre, para el 100% de los equipos estándar,
sin importar qué tan bien midiera el técnico — el cálculo real SÍ se
guardaba correctamente al enviar (el bug era solo de lo que se mostraba
antes de enviar), pero eso no era evidente para quien miraba la pantalla.

**`computeStandardTtrTheoretical_(tapVoltage, lvNominalVoltage, vectorGroup)`**
(nueva, en `app.js`) es la réplica de la fórmula estándar de `calculateTtr_`
— mismo criterio de duplicación intencional que el resto de la app (NIT,
umbrales de Aceite, DAR/IP), documentado con un caso conocido en el propio
comentario de la función para poder verificar alineación manualmente si
alguno de los dos lados cambia. No hay build step que comparta código entre
`app.js` (navegador) y `Código.gs` (Apps Script), así que no es viable una
función realmente compartida — la mitigación es la réplica cuidadosa +
comentario cruzado + verificación en vivo comparando número contra número
(hecha para este cambio, ver abajo), no un test automatizado (este proyecto
no tiene suite de pruebas en ningún módulo).

`computeTtrPreview()` ahora rama igual que el backend: si el equipo usa
matriz personalizada (`usesCustomMatrix()`), sigue leyendo de
`state.matrix.taps` sin cambios; si no, llama a
`computeStandardTtrTheoretical_` y refleja su resultado en 3 estados
posibles por fase, en vez de solo "número o pendiente":

- **`unavailable`** — falta `tap_config.positions[].voltage` (típicamente
  porque `hv_nominal_voltage` estaba vacío al crear el equipo — ver
  `buildDefaultTapPositions_`, `nominalForTaps = 0` si `hv` no vino) o falta
  `lv_nominal_voltage`. En cualquiera de los dos casos no hay ningún
  teórico que calcular, ni siquiera uno impreciso — se muestra
  explícitamente **"Teórico no disponible — falta voltaje nominal de
  placa"** en el lugar del valor (texto atenuado, no color de alerta: es
  un dato ausente, no un cálculo dudoso).
- **`unreliable`** — sí hay tensiones, pero `vector_group` está vacío (o
  trae un valor que no está en `VECTOR_GROUP_MULTIPLIERS`, ej. un typo). Se
  calcula igual con `multiplier = 1` (mismo comportamiento silencioso que
  ya tenía el backend, que nunca cambió) pero ahora se marca visiblemente:
  **"⚠️ &lt;valor&gt; — grupo de conexión no registrado en placa: teórico
  sin factor de relación trifásica, puede ser impreciso"**, en color de
  advertencia (`.theo-unreliable`, mismo token `--warning-text` que el
  resto de la app), y el badge de error % también pasa a ese color
  (`errCls = 'warn'`) en vez de verde/rojo.
- **`ok`** — grupo de conexión reconocido, cálculo normal, sin marca.

**Ninguno de los dos casos bloquea el envío** — el técnico puede seguir
midiendo y guardando la prueba igual, exactamente como ya pasaba antes de
este cambio; lo único que cambió es qué tan honesta es la vista previa
sobre qué tan confiable es el número que está mostrando.

Verificado en vivo con 3 transformadores de prueba:
- **Dyn5, 13200 V / 440 V**: TAP 1 → teórico `54.560` en la vista previa
  (13860/440×√3). Se envió la prueba real y se comparó contra
  `calculated_results.taps['1'].phases[...].appliedTheoreticalRatio` que
  guardó el backend: `54.55960043841963` — coincide exactamente (mismo
  redondeo a 3 decimales). Confirma que frontend y backend no divergieron.
- **`vector_group` vacío** (tensiones completas): la fila muestra
  `⚠️ 31.500 — grupo de conexión no registrado en placa...` en color de
  advertencia, badge de error también en advertencia — no un número
  silenciosamente incorrecto sin marca.
- **`hv_nominal_voltage` vacío**: la fila muestra "Teórico no disponible —
  falta voltaje nominal de placa" en vez de "0.000" o "—" sin contexto.
- **Los 3 casos** enviaron su prueba real sin bloquearse (`"Prueba
  registrada · veredicto: ..."` en los 3), confirmando que la corrección es
  puramente de presentación de la vista previa, no de validación de envío.

**Extendido al backend y al PDF (2026-08-30, mismo día).** La corrección de
arriba solo cubría la vista previa — `calculateTtr_` seguía calculando con
`multiplier=1` sin marcar nada cuando `vector_group` estaba vacío, así que
el informe PDF (documento que sale al cliente) podía mostrar el mismo
número dudoso sin ninguna advertencia. `calculateTtr_` ahora devuelve dos
flags nuevos en su objeto de resultado, calculados **solo en la ruta
estándar** (con matriz personalizada ambos son siempre `true`, los valores
ya son explícitos):

- **`theoreticalReliable`** — `false` si `!transformer.vector_group`.
- **`theoreticalAvailable`** — `false` si falta `lv_nominal_voltage`, o si
  algún TAP medido no tiene `tap_config.positions[].voltage` (0, típico de
  `hv_nominal_voltage` vacío al crear el equipo).

**No se tocó ningún cálculo existente** — ni el valor numérico de
`appliedTheoreticalRatio`/`errorPercent`/`status` por fase, ni
`overallVerdict` — solo se agregaron los dos flags nuevos al objeto que ya
se devolvía. `undefined` en cualquiera de los dos (informes generados antes
de este cambio, sin estos campos en `calculated_results_json`) nunca
dispara advertencia — el chequeo es `=== false` explícito, no `!value`.

**PDF** (`appendTtrTheoreticalWarning_`, llamada desde
`appendTtrResultsTable_` justo antes de la tabla de resultados) — mismo
lenguaje que la vista previa del frontend: si `theoreticalAvailable ===
false`, "Teórico no disponible — falta voltaje nominal de placa." (fondo
`WARNING_BG`, texto `WARNING`, mismo tratamiento visual que
`appendVerdictBanner_`); si no pero `theoreticalReliable === false`, "⚠
Grupo de conexión no registrado en placa — teórico sin factor de relación
trifásica, puede ser impreciso." Cuando el teórico no está disponible, las
columnas "RELACIÓN TEÓRICA"/"ERROR %"/"ESTADO" de la tabla también se
fuerzan a "—"/"—"/"PENDIENTE" en vez de mostrar el `0.0000`/`RECHAZADO`
fabricado que salía del cálculo real (`0/lv` da `0`, no `NaN` — un número
real, aunque sin sentido; `errorPercent` sí llegaba a `Infinity`/`NaN`,
que se vuelve `null` en el JSON guardado, pero `appliedTheoreticalRatio`
en 0 sobrevivía el viaje). Cuando es solo no confiable (`vector_group`
vacío pero con tensiones), la tabla sí muestra el número real calculado
(igual que antes) — la advertencia lo acompaña, no lo reemplaza, mismo
criterio que la vista previa.

**Nunca bloquea nada** — ni el guardado de la prueba ni la generación del
PDF cambian de comportamiento en caso de error; los flags son puramente
informativos, calculados dentro del mismo `try/catch` que ya envolvía toda
la generación de informes.

Verificado: caso "Dyn5, tensiones completas" (ya probado en la corrección
anterior) revisado por código, no en vivo de nuevo — `theoreticalReliable`
exige `!!transformer.vector_group` (true con Dyn5) y `theoreticalAvailable`
exige tensiones + voltaje de TAP presentes (ambos ciertos ahí), así que
ningún flag se activa falsamente en ese camino. Caso nuevo probado en vivo:
transformador con `vector_group` vacío (tensiones completas) → TTR enviado
por API → `calculated_results` devuelto por `submitTtrTest` confirmó
`theoreticalReliable: false, theoreticalAvailable: true` exactamente como
se esperaba, con el PDF combinado regenerado en el mismo flujo de siempre
(`regenerateElectricalCombinedReport_`, sin cambios en su propio código).

**No se tocaron Resistencia de devanados ni Resistencia de aislamiento** —
confirmado antes de tocar nada que ninguno de los dos depende de
`vector_group`/`phase_type`/factor √3 (Devanados es desbalance óhmico
puro; Aislamiento es DAR/IP por cociente de tiempos), así que este bug no
les aplica.

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
`CERTIFICADOS`) para que aparezca en el listado del módulo. Además,
`persistTest_()` genera automáticamente un **informe PDF profesional**
para las 4 pruebas (logo, datos de cliente/equipo, resultados, veredicto,
firmas) y lo guarda en la misma carpeta — ver "Informes PDF de pruebas"
más abajo para el mecanismo completo.

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
`Calibraciones/` sigue el mismo criterio de creación perezosa —
`getCalibracionesFolder_()` la crea la primera vez que
`createCalibracion_`/`updateCalibracion_` suben un certificado. También
existe `ensureDriveStructure_` (solo Administrador) para crearla a mano de
una vez sin depender de esa primera subida, útil al desplegar en una cuenta
nueva.

### Índice de documentos (hoja `DOCUMENTOS`)

Drive no permite listar/filtrar por cliente+tipo+fecha de forma barata sin
recorrer carpetas en cada consulta, así que hay una hoja `DOCUMENTOS`
(`id`, `site_id`, `category`, `file_name`, `file_id`, `mime_type`,
`uploaded_by`, `created_at`) que actúa de índice. `category` es
`CERTIFICADOS` (solo la escribe `persistTest_()`), `OFERTAS_CONTRATOS` o
`GENERALES` (solo subida manual vía `uploadDocument_` — ese endpoint
**rechaza explícitamente** `category: 'CERTIFICADOS'`, los certificados los
sube el sistema, nunca a mano).

**`deleteSite_` borra en cascada las filas de `DOCUMENTOS` de ese
`site_id`** (mismo criterio que `deleteTransformer_` con `PRUEBAS`) — borra
el índice, no el archivo real en Drive. `deleteDocument_` (solo
Administrador, mismo patrón que `deleteTransformer_`/`deleteSite_`) borra
una fila suelta del índice sin necesidad de borrar el Sitio completo —
tampoco borra el archivo real en Drive, solo la fila que apuntaba a él.

### RBAC — caso real, ya implementado

Documentos e Informes **sí tiene la función real** (igual que Calibraciones,
ver su sección dedicada), así que el rechazo por rol documentado antes como
"pendiente" ya está hecho: `listDocuments_(params, auth)` devuelve `403` de una si
`auth.role === 'Tecnico'`, mismo patrón que `deleteTransformer_`/
`deleteSite_`. `uploadDocument_` **no** rechaza por rol — Técnico tiene
`Full` para subir, según la matriz. En el frontend, `renderDocumentsView_()`
ni siquiera arma el HTML de la sección de listado/filtro cuando
`state.role === 'Tecnico'` (no se agrega al DOM, mismo criterio que el resto
de "RBAC" abajo) — un Técnico solo ve el formulario de subida.

## Calibraciones

Módulo completo (dejó de ser placeholder). Catálogo de instrumentos de
**medición propios de M&A** (ej. Micro-ohmmeter DLRO-10) para control de
vigencia ante ente acreditado — **no** es calibración de equipos del
cliente, no confundir con Transformador. Hoja nueva `CALIBRACIONES`:

```
id, modelo, numero_serie, fabricante, fecha_ultima_calibracion,
fecha_proxima_calibracion, ente_acreditado, certificado_adjunto_file_id,
created_at, updated_at
```

- **`modelo`, `numero_serie`, `fecha_proxima_calibracion` son obligatorios**
  al crear (`createCalibracion_` rechaza con 400 si falta cualquiera) —
  `fabricante`, `ente_acreditado` y `fecha_ultima_calibracion` son opcionales.
- **`estado` (semáforo) NUNCA se guarda** — se deriva de
  `fecha_proxima_calibracion` al leer, vía `computeCalibracionEstado_`:
  `Vigente` (más de 30 días para vencer), `Por vencer` (0-30 días),
  `Vencido` (fecha ya pasada). Mismo cuidado con el gotcha de Sheets-Date
  que `computeOfertaEstado_` en Comercial (`fechaProxima instanceof Date`
  antes de decidir cómo construirlo) — verificado en vivo con los tres
  estados a la vez (fechas -10, +15 y +90 días) y con una edición real que
  movió un instrumento de `Vencido` a `Vigente`.
- **Certificado** (opcional, `file_base64`/`file_mime_type`) sube a
  `Calibraciones/` a nivel de proyecto — reutiliza `getCalibracionesFolder_()`
  y `saveFileToDriveIn_()`, que ya existían sin usarse desde Documentos e
  Informes. El `certificado_adjunto_file_id` se guarda directo en la fila de
  `CALIBRACIONES` (no se indexa en la hoja `DOCUMENTOS` — mismo criterio que
  la foto de placa de Transformador, que tampoco se indexa ahí).
- **Corregido durante la verificación en vivo**: el modal de edición
  (`openEditCalibracionModal_`) asignaba `fecha_proxima_calibracion` tal
  cual a un `<input type="date">`, pero ese valor llega como datetime ISO
  completo (`"2026-08-20T05:00:00.000Z"`) cuando Sheets ya autoconvirtió la
  celda a `Date` — un `<input type="date">` ignora silenciosamente un valor
  que no sea exactamente `YYYY-MM-DD`, así que el campo se veía vacío al
  editar. Corregido con `String(fecha).slice(0, 10)`. La tabla del catálogo
  tenía el mismo problema mostrando la fecha cruda en vez de formateada —
  cambiado a `fmtDate_()`, la misma función que usa el resto de la app.

### RBAC — Técnico solo lectura

Único módulo con este nivel exacto: Técnico **ve** el catálogo completo y
el semáforo (`listCalibraciones_` no rechaza ningún rol), pero no puede
crear/editar/eliminar — `checkCalibracionesWriteAccess_(auth)` rechaza con
403 al inicio de `createCalibracion_`/`updateCalibracion_`/
`deleteCalibracion_`, mismo patrón que `checkComercialAccess_`. En
frontend, `renderCalibrationsView_()` no arma el formulario de alta ni los
enlaces "Editar"/"Eliminar" cuando `state.role === 'Tecnico'`. Verificado en
vivo con un token real de Técnico: `listCalibraciones` devuelve el catálogo
completo, `createCalibracion`/`updateCalibracion`/`deleteCalibracion`
devuelven 403 real cada uno por separado, y la vista no muestra ni el
formulario ni los enlaces de escritura.

### `instrument_used` — cruce no bloqueante con Calibraciones (completo)

El campo `instrument_used` (texto libre) existe en **TTR, Resistencia de
devanados y Resistencia de aislamiento** — no en Aceite dieléctrico (ese
módulo no tiene ningún campo equivalente; su "Certificado del ente
acreditado" es del laboratorio que analiza la muestra, no de un instrumento
de M&A). Decisión evaluada, reportada y confirmada por el usuario: **se
descartó el selector obligatorio** — forzaría a que el catálogo exista y
esté completo antes de poder enviar cualquier prueba, bloqueando a un
técnico en campo con un instrumento nuevo aún no registrado (choca con el
principio ya establecido de esta app de nunca bloquear al técnico por una
dependencia externa) y dejaría huérfano todo el `instrument_used` de texto
libre ya guardado en producción. El campo **sigue siendo texto libre puro**,
sin ningún cambio de esquema ni de contrato con el backend:

- **`<datalist id="instrumentCatalogList">`** (una sola, compartida por los
  3 `<input list="instrumentCatalogList">`, en `index.html`) —
  `loadInstrumentCatalogForTestForms_()` en `app.js` la llena con
  `"modelo · numero_serie"` de cada instrumento del catálogo cada vez que se
  abre uno de los 3 formularios (`showView()`, casos `ttr-form`/
  `winding-form`/`insulation-form`). Falla en silencio si `listCalibraciones`
  no responde — es una ayuda opcional, nunca debe interrumpir un formulario
  de prueba real.
- **Comparación difusa** (`normalizeInstrumentText_`/`findMatchingCalibracion_`
  en `app.js`): minúsculas, sin acentos (`.normalize('NFD')` + filtro
  alfanumérico — el filtro alfanumérico ya elimina las marcas diacríticas
  sobrantes de la descomposición NFD, no hace falta un rango Unicode
  explícito), luego contención de substring en cualquier dirección contra
  `modelo` o `numero_serie` normalizados. Exige mínimo 3 caracteres
  normalizados a ambos lados para evitar falsos positivos con textos cortos.
- **Advertencia no bloqueante** (`warnIfInstrumentExpired_`): se llama justo
  después de construir el payload en `submitTtr`/`submitWinding`/
  `submitInsulation`, **antes** de `callApi(...)` pero sin esperar ni
  condicionar el envío — si el texto coincide con un instrumento `Vencido` o
  `Por vencer`, muestra un toast (`showToast_(msg, 'warning', 6000)`, nueva
  variante de color agregada en `styles.css` junto a `success`/`error`); si
  no hay coincidencia o el instrumento está `Vigente`, no hace nada. El
  envío real sigue su curso exactamente igual en ambos casos.
- **Verificado en vivo en los 3 formularios**: instrumento vencido
  (coincidencia por modelo, por número de serie, y con variaciones de
  escritura/texto adicional alrededor) → toast de advertencia visible y la
  prueba se registró igual (o llegó igual de lejos hasta una validación de
  negocio no relacionada, en el caso de Aislamiento con lecturas en cero);
  texto sin ninguna relación con el catálogo → cero advertencias falsas,
  envío normal. `<datalist>` confirmado con las opciones reales del catálogo
  en los 3 inputs (`list="instrumentCatalogList"`).

## Comercial — Ofertas y Licitaciones

Módulo completo (dejó de ser placeholder). Hoja nueva `OFERTAS`:

```
id, cliente_nombre, site_id, tipo, descripcion, valor_cotizado,
fecha_envio, fecha_cierre, estado, responsable,
adjunto_propuesta_file_id, adjunto_contrato_file_id, bitacora_json,
estado_changed_at, created_at, updated_at
```

- **`cliente_nombre` es texto libre, siempre obligatorio** — una oferta NO
  necesita que exista un Sitio todavía (a diferencia de Transformador, que
  sí exige `site_id`). `site_id` es opcional y se puede vincular después.
- **`tipo`**: `OFERTA_DIRECTA` | `LICITACION_PUBLICA`.
- **`estado` guardado** solo puede ser `Pendiente` (default al crear,
  forzado — no se puede crear directo en otro estado) → `Aprobada` /
  `Rechazada` (transición manual vía `updateOferta_`). **`'Cierre'` NUNCA se
  escribe en la hoja** — es un valor derivado que calcula
  `computeOfertaEstado_(row)` al leer, cuando `estado` guardado sigue
  `Pendiente` y `fecha_cierre` ya pasó. `ofertaRowToJson_` expone ambos:
  `estado` (el efectivo, con Cierre ya aplicado) y `estado_real` (lo que
  hay en la hoja) — el frontend usa `estado_real` para decidir si mostrar
  los botones Aprobar/Rechazar (una oferta en Cierre derivado técnicamente
  sigue "Pendiente" en la hoja, así que sí se puede aprobar/rechazar después
  si llega respuesta tarde).
- **Corregido durante la verificación en vivo**: `computeOfertaEstado_`
  hacía `row.fecha_cierre + 'T23:59:59'` asumiendo que siempre era string —
  pero Sheets **autoconvierte una celda que "parece fecha"** (escrita por
  `appendRow_`/`setValue`) a un objeto `Date` real al leerla. Concatenar
  texto sobre un `Date` llama a su `toString()` y produce basura que `new
  Date()` no puede parsear (`Invalid Date`, sin lanzar error) — la
  transición a Cierre nunca disparaba. Ya corregido: distingue si
  `row.fecha_cierre instanceof Date` antes de decidir cómo construirlo. Ojo
  con este mismo patrón si se agrega otro campo de fecha en cualquier hoja.
- **`estado_changed_at`** solo se pone en las transiciones manuales
  (Aprobada/Rechazada) — se usa para el KPI de tiempo de respuesta. Para una
  oferta que cayó en Cierre derivado (nunca hubo transición manual), el
  dashboard usa `fecha_cierre` como proxy del "fin" en su lugar.
- **`bitacora_json`** es un array `[{fecha, autor, nota}]` — `addOfertaNota_`
  hace *append*, no reemplaza; existe para poder agregar una nota de
  seguimiento sin reabrir el formulario completo (el modal de detalle en
  frontend lo maneja con una mini-caja de texto propia).

### Adjuntos — carpeta según si hay Sitio vinculado o no

Nueva carpeta a nivel de proyecto: `Comercial - Prospectos sin cliente/`
(mismo nivel que `Calibraciones/`, ID persistido igual —
`getProspectosSinClienteFolder_()`). Regla:

- **Con `site_id`** (al crear, o ya vinculada): el adjunto va directo a
  `[Cliente]/Ofertas y Contratos/` vía `ensureSiteFolders_(site)`.
- **Sin `site_id`**: el adjunto va a `Comercial - Prospectos sin cliente/`.
- **Al vincular una oferta sin Sitio a un Sitio real** (`updateOferta_` con
  `site_id` nuevo): `moveOfertaAttachmentsToSite_()` **mueve** (no copia)
  cualquier adjunto ya subido — `DriveApp.getFileById(id).moveTo(carpeta)`
  conserva el mismo `fileId`, solo cambia de carpeta contenedora.
  Confirmado en vivo: el `fileId`/URL del adjunto es idéntico antes y
  después de vincular.
- `updateOferta_` acepta un archivo nuevo en el mismo request que otros
  cambios (`file_base64`/`file_slot: 'contrato'` para el contrato de una
  oferta Aprobada, o sin `file_slot` para reemplazar la propuesta) — va
  directo a la carpeta correcta según si ya hay Sitio vinculado o no, sin
  pasar primero por prospectos.

### RBAC — el caso más estricto del sistema

**"Sin acceso" para Técnico en TODAS las acciones**, no solo lectura como
Documentos — `checkComercialAccess_(auth)` se llama al inicio de
`createOferta_`/`updateOferta_`/`addOfertaNota_`/`listOfertas_`/
`deleteOferta_` y devuelve 403 antes de cualquier otra validación.
Verificado en vivo con un token real de Técnico (cuenta de prueba
`test.tecnico.verificacion`, creada con `createUser` para esta verificación
y dejada activa como cuenta reutilizable para futuras pruebas de rol — no
hay acción `deleteUser` en Control de Acceso para borrarla): tanto
`listOfertas` como `createOferta` devolvieron 403 real, no simulado. En
frontend, ni el nav-item ni `view-commercial` se agregan al DOM para
Técnico (mismo patrón que Administración/Panel General).

`deleteOferta_` es **más estricto que el resto del módulo**: solo
Administrador, no Supervisor — mismo criterio que
`deleteTransformer_`/`deleteSite_` (borrar es más sensible que crear/
editar). El botón "Eliminar oferta" en el modal de detalle solo se pinta
para ese rol.

### Dashboard

Todo calculado **client-side** desde el `listOfertas_` completo (sin acción
de backend dedicada a estadísticas) — mismo criterio de "sin librería de
gráficas" que el resto de la app: `computeComercialStats_()` da los KPIs
(pipeline, ganado, conversión, tiempo de respuesta) y
`renderComercialMonthlyTable_()` agrupa por mes (`fecha_envio.slice(0,7)`)
en una tabla, no un canvas.

## Panel General

Módulo completo (dejó de ser placeholder). Dashboard de una sola pantalla,
consolidado, **sin ninguna entidad ni acción de backend propia** (salvo
`estado_equipo`, ver arriba) — solo consume lo que ya exponen
`listTransformers`/`listTests`/`listOfertas`/`listDocuments`/
`listCalibraciones` y **reutiliza
directamente `computeComercialStats_()`** (la misma función del dashboard de
Comercial) para no duplicar ningún cálculo. `renderGeneralDashboardView_()`/
`loadGeneralDashboardAndRender_()` en `app.js`, contenedor
`#generalDashboardViewBody` creado dinámicamente igual que Comercial (ver
"Navegación" abajo).

- **Transformadores activos**: cuenta `listTransformers({})` (todos los
  sitios) filtrando `estado_equipo === 'Activo'` — no es el total de
  equipos, es el conteo real de activos.
- **Pruebas del mes**: cuenta `listTests({})` (todos los tipos: TTR +
  Devanados + Aceite + Aislamiento juntos, ya que `PRUEBAS` es una sola hoja
  con `test_type`) cuyo `created_at` cae en el mes en curso
  (`String(created_at).slice(0,7)` — seguro porque `created_at` siempre se
  genera con `new Date().toISOString()` y llega ya serializado como string
  en el JSON de respuesta, aunque Sheets lo haya guardado como `Date`
  interno; no aplica el mismo gotcha de `computeOfertaEstado_` porque eso
  ocurre solo si se hace concatenación de texto directo sobre el valor crudo
  de Sheets dentro del backend, no sobre el JSON ya serializado).
- **Comercial** (valor en pipeline, valor ganado, tasa de conversión):
  llama a `computeComercialStats_(ofertas)` con el resultado de
  `listOfertas({})` — literalmente la misma función, no una reimplementación.
  Verificado en vivo que los tres números coinciden exactamente con los que
  muestra el dashboard propio de Comercial para el mismo dato.
- **Calibraciones** (instrumentos por vencer / vencidos): cuenta
  `listCalibraciones({})` por `estado` — reutiliza el mismo campo `estado`
  que ya calcula `calibracionRowToJson_` en el backend (el semáforo se
  calcula una sola vez, server-side; Panel General y la vista propia de
  Calibraciones consumen el mismo valor, no hay cálculo duplicado).
  Verificado en vivo con un instrumento de prueba vencido: la tarjeta mostró
  "0 por vencer · 1 vencidos".
- **Documentos recientes**: últimos 8 de `listDocuments({})` (todos los
  clientes), ordenados por `created_at` descendente, con fecha + cliente
  (resuelto contra `listSites`) + tipo (`DOCUMENT_CATEGORY_LABELS`, la misma
  constante que usa Documentos e Informes).
- **Pruebas por mes**: tabla (no canvas, mismo criterio que el resto de la
  app) agrupando `listTests({})` por mes y `test_type`.

### RBAC — sin acción de backend propia que proteger

A diferencia de Comercial/Documentos, Panel General no introduce ningún
endpoint nuevo, así que no hay nada propio que rechazar por rol a nivel de
backend. La protección real es la misma de siempre para módulos "Sin
acceso": frontend 100% (nav-item y `#view-general-dashboard` no se agregan
al DOM para Técnico, mismo patrón que Comercial). De los cinco endpoints
que Panel General consume, `listOfertas_`/`listDocuments_` **ya** rechazan a
Técnico con 403 por su cuenta (así que ni llamándolos directo un Técnico ve
esos números); `listTransformers_`/`listTests_`/`listCalibraciones_` se
dejan **abiertos a propósito** — `listTransformers_`/`listTests_` porque
Técnico tiene `Full` en Equipos y Pruebas, `listCalibraciones_` porque
Técnico tiene lectura completa del catálogo en su propio módulo (ver
"Calibraciones" arriba) — los tres son compartidos con esos módulos, no
exclusivos de Panel General. Verificado en vivo con un token real de
Técnico: sin nav-item ni sección en el DOM, `listOfertas` y `listDocuments`
devuelven 403 real, `listTransformers` sigue funcionando (como debe ser,
para su propio módulo Equipos).

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

## Informes PDF de pruebas

Generación automática, **dentro de `persistTest_()`**, justo después de
guardar la prueba — no es una acción separada que el técnico deba disparar.
Dos formatos, dos mecanismos de disparo distintos (ver
"Arquitectura del informe eléctrico" más abajo): Aceite genera un PDF por
cada envío (`generateOilTestReportPdf_`); TTR/Devanados/Aislamiento
**regeneran un único PDF combinado por transformador**
(`regenerateElectricalCombinedReport_`). Mismo mecanismo de construcción de
PDF debajo de los dos.

### Mecanismo — `DocumentApp` programático, no plantilla de Google Docs

Se evaluaron las dos opciones y se descartó la plantilla con reemplazo de
texto **por los dos requisitos que más importan**: TTR necesita cualquier
número de TAPs (tabla de tamaño variable) y Aceite necesita 1-3 secciones
que pueden estar activas o no (secciones enteras condicionales). Una
plantilla tiene una tabla de filas fijas — soportar "cualquier cantidad de
TAPs" ahí igual requeriría manipular filas ya copiadas en código, tan
frágil como construir desde cero pero con una capa extra de fragilidad para
encontrar/borrar secciones por texto. Construir el documento completo por
código evita eso: los bucles arman las tablas con cualquier cantidad de
filas (`appendTtrResultsTable_`/`appendWindingResultsTable_` iteran
`Object.keys(...)`/arrays sin límite), y las secciones de Aceite
simplemente no se agregan si `calculated.sections.<nombre>` no existe
(`generateOilTestReportPdf_`, tres `if` independientes).

Flujo: `DocumentApp.create(...)` (Doc temporal) → se arma el contenido →
`doc.saveAndClose()` → `docFile.getAs('application/pdf')` → el PDF se
guarda en `[Cliente]/Certificados de Pruebas/` (mismo `certificadosFolderId`
que ya usa el adjunto crudo) → el Doc intermedio se manda a la papelera
(`setTrashed(true)`) — solo el PDF queda como archivo real. Todo en
`finalizeReportPdf_`.

**Nunca bloquea el guardado de la prueba**: la generación va envuelta en
`try/catch` dentro de `persistTest_` — si algo falla, la prueba se guarda
igual, solo con `report_file_id` vacío.

### Logo — subido a Drive, no embebido en el código

El logo (`assets/logo-ma.png` en este repo, PNG 512×512 con transparencia,
ya usado en el login de la app) **no es accesible desde el backend en
tiempo de ejecución** — Apps Script no tiene acceso al repo de GitHub. Se
subió una sola vez vía una acción nueva, `uploadLogoAsset_` (solo
Administrador, mismo patrón que `getRootFolder_`/`getCalibracionesFolder_`):
sube el PNG tal cual (cero conversión, DocumentApp lo acepta directo con
`appendImage`) a la carpeta raíz del proyecto y persiste su `fileId` en
Propiedades del script (`LOGO_FILE_ID`). `getLogoBlob_()` lo lee en cada
informe; si el ID no existe o el archivo se borró, el informe se genera
igual, solo sin logo — nunca bloquea.

### Diseño visual — formato de "protocolo de pruebas" industrial

Rediseñado (2026-08-30) a partir de una referencia visual real que dio el
usuario (un protocolo de otra empresa de pruebas eléctricas) — se adoptó la
**estructura y densidad**, no la marca ni los colores de esa referencia
(esos siguen siendo los de M&A, ver `PDF_COLORS_`). Cambios concretos sobre
la primera versión (que usaba tablas simples de 2 columnas y encabezados de
texto plano):

- **`appendSectionTitle_`** ya no es un párrafo con texto coloreado — es una
  barra de ancho completo, fondo `--accent` sólido, texto blanco en
  mayúsculas (tabla de 1x1 sin bordes), mismo tratamiento que las barras de
  sección del protocolo de referencia.
- **`appendProtocolTitle_`** (nuevo) — caja con borde y fondo
  `--accent-soft`, texto `--accent` en negrita centrado — "PROTOCOLO DE
  PRUEBA DE [TIPO]" (`TEST_TYPE_PROTOCOL_TITLE_`, un texto por tipo de
  prueba), justo debajo del encabezado con logo. Reemplaza el título
  genérico "M&A Ingeniería y Consultoría SAS" en tamaño `TITLE` que tenía
  la primera versión.
- **`appendDenseInfoGrid_`** (nuevo, reemplazó `appendInfoTable_`, que se
  borró por quedar sin uso) — grilla de 4 columnas (etiqueta/valor × 2 por
  fila, etiquetas en mayúsculas con fondo gris) en vez de una etiqueta por
  fila — mismo criterio de densidad que el protocolo de referencia
  (`MARCA | valor | POTENCIA | valor`, no una fila por campo). Se usa en
  "Datos del cliente y del equipo" (fusionadas en una sola sección, antes
  eran dos separadas), "Datos de la prueba" y "Datos de la muestra" (Aceite).
- **Encabezado logo + nombre lado a lado**: tabla de 1x2 sin bordes (el
  logo va en `logoCell.appendImage(blob)` — un `TableCell` sí soporta
  `.appendImage()` igual que `Body`, confirmado en vivo) en vez de logo y
  nombre apilados verticalmente.
- **"Firmas" → "Área de control de calidad"**: mismo nombre y ubicación
  (al final, junto a las firmas) que la sección equivalente del protocolo
  de referencia — la columna "Técnico responsable" pasó a llamarse
  "PROBADO POR".
- Encabezados de las tablas de resultados (TTR/Devanados/Aislamiento/
  Fisicoquímico/DGA/PCB) pasaron a mayúsculas.

### Colores y cruce con Calibraciones — duplicados a propósito

- **Colores del veredicto** (`PDF_COLORS_`/`verdictColor_`): un PDF no
  puede leer variables CSS, así que los hex exactos de `styles.css`
  (`--accent`/`--success`/`--warning`/`--danger` y sus `-bg`) están
  duplicados en `Código.gs`. Si cambian los colores de la app, cambiar
  aquí también. `verdictColor_` replica el mismo criterio de severidad que
  ya usan los pills en pantalla — `REGISTRADO` (Aceite con solo DGA) y
  cualquier veredicto no reconocido caen en neutro.
- **Vigente/vencido según Calibraciones**: `findMatchingCalibracionServer_`/
  `normalizeInstrumentTextServer_` son la réplica server-side EXACTA de
  `findMatchingCalibracion_`/`normalizeInstrumentText_` en `app.js` (mismo
  algoritmo — contención de substring, mínimo 3 caracteres) — hace falta
  duplicarlo porque el informe se genera en el backend, sin acceso al JS
  del frontend. Si no encuentra coincidencia, el informe simplemente no
  muestra estado de vigencia (no bloquea).

### Dos discrepancias con el pedido original, resueltas por el modelo de datos real (no inventadas)

- **No existe "modelo" en Transformador** — el informe usa `manufacturer`
  (Fabricante) + `serial_number` (Serie) + las características de placa
  que sí existen, en vez de un campo que no está en el esquema.
- **`ente_acreditado` no existe en la prueba de Aceite** (solo existe en
  Calibraciones, que es para instrumentos de M&A, no para el laboratorio
  externo) — el informe de Aceite omite esa referencia en vez de
  inventarla; si se necesita, es un campo nuevo al formulario de Aceite,
  pendiente de decidir.
- **No existe "bitácora"/observaciones libres en Prueba** (solo existe en
  Ofertas) — el pedido decía "si existe"; como no existe, la sección
  Observaciones simplemente no se generó, en vez de agregar un campo nuevo
  sin que se pidiera explícitamente.

### Informe de Prueba Eléctrica (TTR / Devanados / Aislamiento) — un PDF combinado por envío, histórico completo conservado

**Dos correcciones de arquitectura (2026-08-30), en secuencia.** La primera
versión generaba un PDF por cada envío individual de prueba (un
`generateElectricalTestReportPdf_` por TTR, otro por Devanados, otro por
Aislamiento — igual que Aceite). El usuario señaló, comparando contra la
imagen de referencia y el resultado real en Drive, que eso no coincide con
cómo se maneja un protocolo de pruebas eléctricas en la práctica: **las
pruebas eléctricas de un transformador van en un solo documento**, no una
por prueba. Causa raíz: el modelo de datos no tiene un concepto de "visita
de pruebas" que agrupe TTR+Devanados+Aislamiento hechos el mismo día —
cada envío es una fila independiente en `PRUEBAS`. Se le preguntó
explícitamente al usuario el criterio de consolidación (`AskUserQuestion`)
— eligió "un solo PDF, siempre el más reciente, reemplazando el anterior".

**Segunda corrección, el mismo día**: esa primera implementación borraba
el PDF viejo de Drive y su fila en `DOCUMENTOS` en cada envío. El usuario
pidió explícitamente **no perder histórico** — cada envío que dispara una
regeneración debe quedar como su propio PDF con timestamp, sin borrar ni
sobrescribir los anteriores. Se mantiene la idea de agrupar los 3 tipos en
un solo documento (eso sí seguía siendo correcto), pero cada generación es
ahora un archivo nuevo, no un reemplazo. Aceite dieléctrico se deja fuera
de este mecanismo a propósito — el pedido original ya lo trataba como
conceptualmente distinto ("un formato para pruebas eléctricas y otro para
aceite"): es el análisis de una muestra puntual con su propio laboratorio
acreditado, no una medición repetible del mismo equipo.

**Fuente de verdad del histórico vs. caché del más reciente** — dos campos
con roles distintos, a propósito:
- **`DOCUMENTOS`** (una fila por generación, categoría `CERTIFICADOS`,
  `file_name` con timestamp: `Informe_Electrico_<serie>_<yyyy-MM-ddTHH-mm-ss>`)
  es la fuente de verdad del histórico completo. Nunca se borra ni se
  deduplica — el módulo "Documentos e Informes" (`applyDocumentFilters_`
  en `app.js`) ya lista todas las filas de `listDocuments_` sin filtrar
  por nombre, así que cada versión queda visible/descargable ahí
  automáticamente. No hizo falta UI nueva para esto.
- **`electrical_report_file_id`** — columna en `HEADERS.TRANSFORMADORES`
  (al final). Es una propiedad **del transformador**, no de la prueba, y
  **solo cachea el fileId del PDF más reciente** — nunca se lee como
  fuente de histórico, se sobrescribe en cada generación.
  `transformerRowToJson_` la expone como `electrical_report_url`
  (`driveFileUrl_(...)`, `null` si nunca se generó). En el frontend
  (`renderDetail()` en `app.js`) aparece como un pill verde clickeable
  "Informe eléctrico combinado (PDF)" junto al pill de Grupo, en el header
  del detalle del equipo — acceso rápido al último, no al historial.

`persistTest_` — para TTR/Devanados/Aislamiento, después de guardar la
fila en `PRUEBAS` (con `report_file_id` vacío: esta prueba individual no
genera su propio PDF suelto, entra al combinado), llama a
`regenerateElectricalCombinedReport_(transformer, site, folderId, testedBy)`
dentro de su propio `try/catch` (nunca bloquea el guardado de la prueba,
igual que el resto de la generación de informes):

1. `findLatestElectricalTestsByType_(transformerId)` — recorre `PRUEBAS`
   una vez y se queda con la fila más reciente (`created_at` más alto) de
   cada uno de los 3 tipos; un tipo nunca probado queda `null`. La prueba
   recién guardada ya está en la hoja para este momento, así que sí entra
   en la comparación.
2. Se arma **un solo** Doc: `appendReportHeader_` (encabezado + datos del
   cliente y equipo, una sola vez) → por cada tipo presente, en orden fijo
   TTR → Devanados → Aislamiento,
   `appendElectricalTypeSection_(body, type, latestTest)` — que es
   `appendTestMetaSection_(body, testMeta, TEST_TYPE_DISPLAY_LABEL_[type])`
   (el título lleva el tipo, ej. "Datos de la prueba — TTR", porque puede
   haber hasta 3 en el mismo documento) + la tabla de resultados de ese
   tipo (`appendTtrResultsTable_`/`appendWindingResultsTable_`/
   `appendInsulationResultsTable_`, sin cambios) + su veredicto — → un solo
   `appendSignatureSection_` al final, firmado por el técnico de la prueba
   más reciente de las presentes.
3. `finalizeReportPdf_` guarda el PDF nuevo con nombre timestamped
   (`fmtTimestampForFilename_`, mismo cuidado de timezone que
   `fmtDatePdf_` — `Utilities.formatDate` en `America/Bogota`, no
   `toISOString()` que da UTC), se **sobrescribe** el caché
   `TRANSFORMADORES.electrical_report_file_id` con el fileId nuevo
   (`colIndex_('TRANSFORMADORES', 'electrical_report_file_id')`), y se
   **agrega** (nunca se reemplaza) una fila nueva en `DOCUMENTOS`.

Si un transformador solo tiene TTR probado (Devanados/Aislamiento nunca
enviados), el PDF combinado tiene una sola sección — no hay tablas vacías
para los tipos ausentes, `present = order.filter(t => latest[t])` los
excluye desde el armado.

- **TTR** (`appendTtrResultsTable_`): una fila por (TAP, fase) —
  `calculated.taps` recorrido con `Object.keys().map(Number).sort()` para
  que salga en orden numérico aunque el objeto no lo garantice.
- **Devanados** (`appendWindingResultsTable_`): tabla del primario (una
  fila por TAP × fase) + tabla "Secundario" aparte **solo si**
  `calculated.secondary` no es `null`.
- **Aislamiento** (`appendInsulationResultsTable_`): una fila por
  combinación de `calculated.measurements` (en la práctica siempre
  AT-BT/AT-Tierra/BT-Tierra, pero el código no asume esas claves — igual
  de genérico que el propio `calculateInsulation_`).

Verificado en vivo (2026-08-30): transformador de prueba con TTR →
Devanados → Aislamiento enviados en secuencia — cada envío generó un PDF
combinado nuevo (fileId distinto cada vez), acumulando filas en
`DOCUMENTOS` en vez de reemplazar (2 envíos de TTR seguidos → 2 PDFs
distintos, 2 filas). El pill del header siguió apuntando al más reciente
después de cada envío. El PDF final (inspeccionado directamente, descargado
vía un endpoint de debug temporal) contiene las secciones de los tipos
probados con los datos más recientes de cada uno, un solo encabezado y una
sola sección de firmas.

### Informe de Análisis de Aceite Dieléctrico — plantilla distinta

`generateOilTestReportPdf_` — mismo encabezado compartido, pero después:
"Datos de la muestra" (`sample_taken_by`/`sample_date`, no instrumento de
M&A) → **solo** las secciones con `calculated.sections.<nombre>` presente
(Fisicoquímico con las 7 lecturas ASTM del `rawReadings` + su método;
DGA con los 9 gases + nota de que no tiene interpretación automática
todavía; PCB con los 7 Aroclores + total + nota IDEAM) → referencia al
adjunto crudo si el técnico subió uno ("Este informe es un resumen/
interpretación... no reemplaza el certificado del laboratorio acreditado")
→ veredicto general → Área de control de calidad.

### Storage y el link en el historial de pruebas

`report_file_id` — columna en `HEADERS.PRUEBAS`, al final (misma regla de
siempre: nunca insertar en medio). **Desde la corrección de arquitectura
de arriba, solo la queda usando Aceite** — TTR/Devanados/Aislamiento
guardan su fila de `PRUEBAS` con `report_file_id` vacío, porque su informe
ya no es por-prueba sino por-transformador
(`TRANSFORMADORES.electrical_report_file_id`, ver arriba). El PDF
generado (de cualquiera de los dos mecanismos) se indexa **también** en
`DOCUMENTOS` (categoría `CERTIFICADOS`, `file_name` con prefijo `Informe_`
para distinguirlo del adjunto crudo que no lo lleva) — así aparece en el
listado de Documentos e Informes igual que cualquier otro certificado.

`listTests_` expone `report_url` **además de** (no en vez de)
`attachment_url` — son cosas distintas: `report_url` es el informe
generado, `attachment_url` es lo que el técnico subió a mano (evidencia
cruda, foto del equipo de prueba, etc.), y pueden coexistir. En el
historial de pruebas (`renderDetail()` en `app.js`), la columna
"Documentos" muestra hasta dos links **claramente etiquetados por
separado**: "Informe" (si existe) y "Evidencia" (si el técnico subió
algo) — nunca un solo link ambiguo que mezcle los dos. Para Aceite,
`report_url` normalmente está presente (informe por envío). Para
TTR/Devanados/Aislamiento, `report_url` es `null` por diseño — el informe
de esas pruebas no vive en la fila de la prueba sino en el pill "Informe
eléctrico combinado (PDF)" del header del equipo
(`transformer.electrical_report_url`); esas filas del historial muestran
"Evidencia" si el técnico adjuntó algo, o "—" si no.

### Dos bugs reales encontrados generando los 4 informes de prueba en vivo

- **`appendInfoTable_` coerciona números a "N.0"**: pasar un valor numérico
  crudo (ej. `transformer.manufacture_year`, un `Number` de Sheets) directo
  a una celda de `appendTable` lo mostraba como "2020.0" en vez de "2020"
  — problema del puente V8↔Docs-API de Apps Script con números crudos, no
  de JS. Corregido convirtiendo explícitamente con `String(...)` antes de
  pasarlo. Los demás campos numéricos del informe ya iban concatenados con
  texto (`transformer.rated_power_kva + ' kVA'`), lo que ya fuerza
  coerción a string en JS antes de cruzar ese límite, así que no tenían el
  mismo problema — revisado uno por uno, `manufacture_year` era el único
  caso que pasaba el número crudo sin concatenar.
- **`fmtDatePdf_` corría un día atrás con fechas puras** ("2026-08-29" se
  mostraba como "28/08/2026"): `new Date("2026-08-29")` interpreta esa
  cadena como medianoche **UTC**, y al formatear en `America/Bogota`
  (UTC-5) se corre al día anterior. Mismo tipo de cuidado que el gotcha de
  Sheets-Date ya documentado en Comercial/Calibraciones, pero de causa
  distinta (timezone, no autoconversión de Sheets). Corregido: una fecha
  pura `YYYY-MM-DD` (sin hora, como `sample_date` de un
  `<input type="date">`) se construye con `new Date(año, mes-1, día)`, que
  Apps Script interpreta en el timezone del script (`America/Bogota`, ver
  `appsscript.json`) en vez de UTC. Un `Date` real (de Sheets) o un ISO
  completo con hora (`created_at`) siguen su camino normal — el bug era
  específico de fechas puras sin componente de hora.

### Gotcha de despliegue — mismo patrón que la migración de cuenta, para un scope nuevo

Agregar `DocumentApp` requirió sumar `https://www.googleapis.com/auth/documents`
a `oauthScopes` en `appsscript.json`. Como con el gotcha ya documentado en
"Infraestructura / cuentas" (acceso anónimo 403 tras crear un deployment
nuevo), **agregar un scope nuevo al manifiesto y desplegar por
`clasp deploy` no completa la autorización real** — las llamadas a
`DocumentApp` seguían fallando con "No cuentas con el permiso..." aunque
el manifiesto y el deployment ya estuvieran actualizados. La diferencia
esta vez: `testAuthorization()` (la función pública que ya existía para
forzar la ventana de autorización) **no sirve para esto** porque no llama
`DocumentApp` para nada — hizo falta agregar `testDocumentAuthorization()`
(crea un Doc de prueba y lo manda a la papelera), ejecutarla manualmente
desde el editor de Apps Script y aceptar el permiso nuevo ahí. Se dejó en
el código (igual que `testAuthorization()`) por si hace falta de nuevo con
un scope futuro.

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
4. **Comercial** — módulo completo (`view-commercial`, contenido en
   `#commercialViewBody`), ver sección dedicada arriba. Ya no es
   placeholder — a diferencia de Documentos e Informes, la sección
   `view-commercial` la crea `renderRestrictedModuleNav_()` dinámicamente
   por JS (es "Sin acceso" para Técnico), pero ya no le mete el HTML
   genérico de "Próximamente": ve `mod.view === 'commercial'` y le arma el
   contenedor real (`renderCommercialView_()` la llena al navegar ahí).
5. **Calibraciones** — módulo completo (`view-calibrations`, contenido en
   `#calibrationsViewBody`), ver sección dedicada arriba. Ya no es
   placeholder.
6. **Documentos e Informes** — módulo completo (`view-documents`), ver
   sección dedicada arriba. Ya no es placeholder.
7. **Panel General** — módulo completo (`view-general-dashboard`, contenido
   en `#generalDashboardViewBody`), ver sección dedicada arriba. Ya no es
   placeholder.
8. **Administración** — Gestión de usuarios (`view-admin`, sin cambios en su
   lógica).

No queda ningún módulo como placeholder puro — los 8 están completos.
Calibraciones y Documentos e Informes son
estáticos en `index.html` (todos los roles tienen algún acceso); Comercial
y Panel General se insertan por JS
(`renderRestrictedModuleNav_()`/`removeRestrictedModuleNav_()` en `app.js`,
mismo patrón que `renderAdminNavAndPanel`/`removeAdminNavAndPanel` —
anclados con `insertAdjacentElement('afterend')` sobre `#navItemDocuments`
en escritorio y `#moreSheetDocumentsItem` en móvil) porque son "Sin acceso"
para Técnico y no deben existir en el DOM para ese rol. Dentro de esa misma
función, `mod.view === 'commercial'`/`mod.view === 'general-dashboard'` son
los dos casos especiales que arman un contenedor real
(`#commercialViewBody`/`#generalDashboardViewBody`) en vez del placeholder
genérico.

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
arriba). **Comercial también, y es el más estricto**: `checkComercialAccess_`
rechaza a Técnico en TODAS las acciones (no solo listar), verificado con un
token real (ver sección de Comercial arriba). **Panel General no tiene
ninguna acción de backend propia** (ver sección dedicada arriba) — su
protección real es 100% frontend; de los endpoints que consume,
`listOfertas_`/`listDocuments_` ya rechazan a Técnico por su cuenta, y
`listTransformers_`/`listTests_`/`listCalibraciones_` se dejan abiertos a
propósito porque son compartidos con Equipos/Pruebas/Calibraciones (Full o
solo-lectura para Técnico en esos módulos respectivamente). **Calibraciones
también tiene rechazo real**: `checkCalibracionesWriteAccess_` rechaza a
Técnico en crear/editar/eliminar (no en listar, que es Full para los 3
roles), verificado con un token real (ver sección de Calibraciones arriba).

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
  reusan tanto para borradores de formulario como para este caché). **Los 4
  módulos construidos después (Comercial, Documentos, Calibraciones, Panel
  General) no lo seguían** — se corrigió (2026-08-30): `loadOfertasAndRender_`
  (`mya_cache_ofertas`), `loadDocumentsAndRender_` (`mya_cache_documents`),
  `loadCalibracionesAndRender_` (`mya_cache_calibraciones`) y
  `loadGeneralDashboardAndRender_` (`mya_cache_general_dashboard`, un solo
  blob con las 6 listas del dashboard) ahora siguen el mismo patrón exacto:
  pintan de `localStorage` de inmediato si hay algo, y si el refresco de red
  falla **y no había caché**, muestran el error (si había caché, el error
  queda silencioso — el usuario ya está viendo algo razonable). Verificado
  en vivo en los 4: segunda visita a cada módulo pinta datos reales de
  inmediato, de forma síncrona, antes de que la petición de red pudiera
  haber resuelto.
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
    conflicto (es el mismo equipo con su serie sin cambios). **Verificado en
    vivo (2026-08-30)**: se dejó un equipo en estado pendiente/error, se creó
    un segundo equipo real con la misma serie desde otro flujo mientras el
    primero seguía pendiente, y al reintentar el primero se rechazó con el
    mensaje de conflicto — el backend confirmó que solo existe un
    transformador con esa serie, sin duplicado. `retryPendingSite_` (Sitio)
    **no** hace este chequeo — no es un bug equivalente, Sitio no tiene un
    campo tipo "número de serie" con regla de unicidad que revalidar.
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

## Rendimiento del backend

Diagnóstico hecho el 2026-08-30 (sin tocar código) encontró 4 causas
concretas de latencia evitable en `Código.gs`; las 4 se corrigieron el mismo
día, verificadas en vivo:

- **`deleteDocument_`** (nuevo, solo Administrador, mismo patrón que
  `deleteTransformer_`/`deleteSite_`) — borra una fila del índice
  `DOCUMENTOS` sin borrar el archivo real en Drive (mismo criterio que
  `deleteTransformer_` con `PRUEBAS`). No existía ninguna forma de borrar un
  documento suelto antes de esto — se usó una vez para limpiar la fila
  huérfana `aislamiento_MIGR-TEST-...` que quedaba documentada arriba como
  pendiente (ya no existe, confirmado en vivo).
- **`getSpreadsheet_()` cachea el handle en `_spreadsheetCache_`** (variable
  de módulo) en vez de llamar `SpreadsheetApp.openById()` cada vez que
  `getSheet_()` se invoca — una sola petición puede llamar `getSheet_()`
  varias veces (`deleteSite_`, por ejemplo, lo hacía 4 veces: `SITIOS` dos
  veces, `TRANSFORMADORES` y `DOCUMENTOS` una vez cada una), así que antes
  de esto cada una de esas llamadas reabría el spreadsheet entero. Es solo
  un handle cacheado, no una foto de los datos — las lecturas siguen yendo
  contra Sheets en vivo cada vez (`getDataRange()`, etc.), así que no hay
  riesgo de servir datos viejos.
- **`routeRequest_` valida el token ANTES de `ensureAllSheets_()`** (antes
  corría al revés) — una petición anónima, con token inválido/expirado, o
  con una acción que ni existe, ya no paga el costo de `ensureAllSheets_`
  recorriendo las 6 hojas (`getSheetByName`/`getLastColumn` por cada una).
  Los chequeos 100% locales (falta `action`, acción no reconocida) siguen
  yendo primero de todos porque son gratis y no tocan red ni Sheets.
  `ensureAllSheets_()` solo corre para peticiones ya autenticadas, justo
  antes de llegar al handler real. Verificado que no rompe nada: ningún
  handler puede ejecutarse sin `auth` válido, así que ningún handler podía
  depender antes de que `ensureAllSheets_` hubiera corrido sin que el token
  también fuera válido — no había ninguna combinación legítima "sheets ya
  garantizadas pero sin auth" que este reorden pudiera romper.
- **`listTests` acepta `light=1`** (o cualquier valor truthy vía
  `isTruthy_`) — omite `raw_readings`/`calculated_results` (ni siquiera se
  hace el `JSON.parse()` de esas dos columnas) para consumidores que solo
  necesitan contar/agrupar. `loadGeneralDashboardAndRender_` en `app.js` ya
  lo usa (`listTests` con `light: 1`) para las tarjetas "Pruebas del mes" y
  "Pruebas por mes" de Panel General. El historial de pruebas del detalle
  de un transformador (`openTransformer`) sigue pidiendo la respuesta
  completa (sin `light`) porque sí necesita el detalle. Verificado en vivo:
  la respuesta `light` no trae esos dos campos, la completa sí, y los
  conteos de Panel General con la respuesta liviana coinciden exactamente
  con los reales.

**Medición aproximada** (no hay un "antes" real comparable — habría
implicado redesplegar la versión vieja a producción solo para medir, lo
cual no se hizo a propósito por el riesgo/disrupción que implica sobre el
despliegue en vivo). Con el código ya optimizado: 5 llamadas seguidas a
`listSites` con token válido dieron 3.3–4.5 s cada una; 5 llamadas con
token inválido dieron 1.6–1.9 s cada una (con una salida atípica de ~8.9 s,
probablemente un cold start puntual) — la diferencia es consistente con que
las peticiones con token inválido ahora se cortan antes de tocar
`ensureAllSheets_` y antes del propio trabajo del handler contra Sheets,
pero la mayor parte del tiempo absoluto en ambos casos sigue siendo la
llamada de red a Control de Acceso (`UrlFetchApp.fetch` dentro de
`validateAuth_`) más el overhead propio de Apps Script — el aporte real de
estas 4 optimizaciones es más visible en peticiones con varios `getSheet_()`
(como `deleteSite_`) y en peticiones rechazadas, no tanto en una lectura
simple de una sola hoja con token válido.

**Diferido a propósito, no por olvido**: paginación/filtrado por fecha en
las acciones `list*` (hoy todas leen la hoja completa con
`getDataRange().getValues()`, sin límite) y cualquier mitigación del cold
start de Apps Script (p. ej. un ping de "keep-warm") — ninguna de las dos
se justifica todavía con el volumen de datos actual (la base se limpia
constantemente durante desarrollo), pero van a importar de verdad cuando
`PRUEBAS`/`DOCUMENTOS`/`OFERTAS` acumulen meses de uso real en campo.

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

No quedan módulos en diseño pendientes de construir ni piezas diferidas —
Calibraciones (incluida la integración `instrument_used` con sus 3
formularios de prueba, ver sección dedicada arriba) fue lo último, y con eso
se cierra el alcance funcional completo de los 8 módulos de navegación.

**Resuelto (2026-08-30)**: `deleteSite_` ahora borra en cascada las filas de
`DOCUMENTOS` de ese `site_id` (mismo criterio que `deleteTransformer_` con
`PRUEBAS`, ver "Jerarquía obligatoria de datos" arriba) — la fila huérfana
que había quedado de antes de este fix (`aislamiento_MIGR-TEST-...`) se
limpió a mano con la nueva acción `deleteDocument_` (ver "Rendimiento del
backend" arriba). Verificado en vivo que ya no queda ningún huérfano.

Ver conversación con Gerson para el detalle completo de campos y KPIs
propuestos — lo de arriba es solo el resumen de alcance, no el diseño final.

Base de datos en vivo: **desde 2026-08-30 vive en la cuenta dedicada nueva**
(ver "Infraestructura / cuentas" arriba), creada desde cero — no es la misma
hoja de antes de la migración. Se mantuvo limpia de datos de prueba hasta
2026-08-30 (verificaciones de migración + Comercial + Panel General/
estado_equipo + Calibraciones + cruce no bloqueante de `instrument_used` —
todo lo creado durante esas verificaciones se borró al terminar, usando
`deleteOferta_`/`deleteTransformer_`/`deleteSite_`/`deleteCalibracion_`). La
hoja/carpeta viejas (cuenta Arrieta Soluciones) ya estaban vacías desde la
limpieza de 2026-08-29 y quedaron así, sin usarse desde la migración.

**Contiene datos DEMO desde 2026-08-30 — no se limpian, quedan a propósito.**
A diferencia de todo lo anterior en este archivo, este lote NO se borró al
terminar: 4 Sitios, 6 Transformadores, 8 Pruebas (los 4 tipos, con veredictos
mixtos a propósito), 3 Calibraciones (una en cada estado del semáforo), 4
Ofertas (Pendiente, Aprobada, Rechazada, y una con `fecha_cierre` ya vencida
para mostrar la transición derivada a Cierre) y 2 documentos subidos a mano.
**Todo nombre de Cliente/Sitio lleva el prefijo `"DEMO - "`** (ej. "DEMO -
Textiles del Norte SAS") y los NIT son de rango de prueba (900000001-4, DV
calculado real por `normalizeNit_`) — para que nadie los confunda con un
cliente real. Cubre a propósito: `estado_equipo` en los 3 valores, un
`vector_group` Dyn (factor √3 correcto en TTR) y otro vacío (advertencia "no
confiable" activa), `numero_posiciones_tap` diligenciado en unos equipos y
vacío en otros (default 5), e instrumentos de Calibraciones usados como
`instrument_used` real en las pruebas (incluido el vencido, para la
advertencia no bloqueante). Antes de agregar o quitar cualquier registro con
prefijo `DEMO -`, ten esto en cuenta — no es basura de verificación, es el
contenido que puebla el Panel General.

**Cuentas de prueba (rol Técnico)** — no hay acción `deleteUser` en Control
de Acceso, así que ninguna de estas se puede borrar:
- `test.tecnico.verificacion` — la original, creada para verificar Comercial.
  **Contraseña ya no es la documentada originalmente** (dejó de funcionar el
  2026-08-30, causa desconocida — probablemente rotó en algún punto) — no
  usar más, queda como cuenta huérfana.
- `test.tecnico.verificacion2` — creada por error el 2026-08-30 sin el
  parámetro `appsPermitidas: 'MYA_PRUEBAS'` en `createUser` — existe pero
  **no tiene acceso a esta app** (`403: "Tu usuario no tiene permiso para
  Gestión de Pruebas"` en cualquier llamada). Cuenta muerta, no usar.
- `test.tecnico.verificacion3` — **la activa hoy**, contraseña
  `QaTemp2026!` (temporal, forzó `debeCambiar`), creada correctamente con
  `appsPermitidas: 'MYA_PRUEBAS'`. Úsala para cualquier verificación futura
  de rol Técnico. Si vuelve a fallar el login, no asumas que el problema es
  RBAC del módulo que estés probando — confirma primero con una llamada
  simple (`listSites`) que la cuenta en sí sigue viva antes de diagnosticar
  nada más.
