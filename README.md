# Riftbound JGT — Archivo de partidas

Página estática (GitHub Pages) que muestra estadísticas de las partidas de **Riftbound** que juega el grupo: ranking de jugadores, winrate por leyenda, matriz de matchups, battlefields más usados, historial, notas/amenazas por leyenda y una "porra" de predicciones. Los datos se rellenan con un Google Form y se sincronizan solos a la web — nadie tiene que tocar código para que se actualice.

**Nombre del grupo en la web:** JGT Enjoyers.

---

## Cambios recientes

**Revisión de fiabilidad (última pasada):**
- El script de Node (`scripts/fetch-sheet.js`) ahora tiene un timeout de 20s por si Google no responde, y se niega a sobrescribir `data.json` si la hoja devolviera 0 filas (para no borrar el historial por un fallo pasajero de permisos).
- El workflow evita ejecuciones solapadas (`concurrency`) y hace `git pull --rebase` de seguridad antes de empujar el commit.
- En `script.js` se unificó el escapado de texto (nombres de jugador y leyenda) en todas las vistas — antes algunas lo hacían y otras no, lo cual era inconsistente aunque no llegara a causar problemas visibles.
- Limpieza general: numeración de secciones del código corregida, una regla CSS que ya no se usaba (`.section__num`, de cuando había números romanos) eliminada, y una estructura de datos interna un poco chapucera (`rounds._matches`) sustituida por algo más claro.
- Cron de la GitHub Action bajado de 30 a 15 minutos.

## Cómo fluyen los datos

```
Google Form (rellena cada uno tras jugar)
        ↓
Google Sheet, pestaña "Respuestas_formulario"  (una fila por partido, hasta 3 rondas)
        ↓
GitHub Action "Actualizar datos de Riftbound"  (corre en el servidor de GitHub cada 15 min)
        ↓
data.json  (se genera solo, vive en la raíz del repo)
        ↓
script.js lo lee al cargar la página y calcula todo en el navegador
```

**Por qué funciona así en vez de leer el Sheet en directo desde el navegador:** al principio `script.js` consultaba Google Sheets directamente desde el navegador de quien visitaba la web. Con algunas VPNs, Google detectaba esa IP como sospechosa y bloqueaba la respuesta, dejando la web en blanco. La solución fue mover esa consulta a un robot de GitHub (que no tiene ese problema) y que la web solo lea un archivo ya preparado (`data.json`) dentro de su propio dominio — así ninguna VPN puede romperla, porque el navegador del visitante nunca llega a hablar con Google.

---

## Estructura del repositorio

```
riftbound-jgt-stats/
├── .github/workflows/update-data.yml   → tarea automática que genera data.json
├── scripts/fetch-sheet.js              → script que descarga el Sheet y lo convierte a JSON
├── data.json                           → generado solo, NO se edita a mano
├── index.html                          → estructura de la página (pestañas y secciones)
├── style.css                           → todo el diseño visual
├── script.js                           → toda la lógica: cálculos y renderizado
└── assets/
    ├── icons/          → favicon del sitio
    └── imgs/           → fotos de jugadores (ver convención de nombres más abajo)
```

---

## Las pestañas de la web

| Pestaña | Qué muestra |
|---|---|
| **Inicio** | Resumen: partidas totales, jugador líder (con foto grande), leyenda más jugada, formato BO1/BO3, y una ficha con récord y leyenda favorita del líder + 2º y 3º puesto. |
| **Invocadores** | Ranking de jugadores por % de victorias. |
| **Leyendas** | Winrate global de cada leyenda, sin importar quién la jugó (cálculo simétrico: cuenta tanto si la jugaste tú como si la jugó tu rival). |
| **Battlefields** | Ranking de battlefields más elegidos, en general y filtrando por leyenda. |
| **Enfrentamientos** | Matriz leyenda × leyenda con el % de victorias de cada cruce, coloreada (rojo = mal matchup, verde/teal = dominante). |
| **Crónica** | Listado de partidas recientes, con scroll interno. |
| **Comentarios** | Notas y amenazas que cada uno anota tras la partida, con filtro por leyenda. |
| **Gameplan** | Eliges tu leyenda → ves su winrate contra cada rival → haces clic en una rival y aparece debajo un desglose de Amenazas y Notas, separando lo más relevante (lo que anotaste jugando tu leyenda contra esa rival) de lo secundario. |
| **Otros ▾** | Menú desplegable con **La Porra** (tabla de predicciones de cada uno) y **Mandamientos** (las leyes sagradas del grupo). |

---

## Cómo se calculan los datos (resumen)

- **Una fila del formulario = un partido** (hasta 3 rondas). `script.js` las "desenrolla" en rondas individuales para poder analizarlas.
- **Formato BO1/BO3**: si solo se jugó la 1ª ronda, es BO1; si se jugó una 2ª o 3ª, es BO3.
- **Winrate de leyenda**: simétrico — cada ronda cuenta tanto para la leyenda que jugaste tú como para la del rival, así no depende de quién rellenó el formulario.
- **Jugador "Invitado"**: excluido de todas las estadísticas (partidas de prueba). Configurable en `CONFIG.EXCLUDE_PLAYERS` dentro de `script.js`.
- **Matriz de matchups**: mínimo 2 partidas para considerarse "fiable" (por debajo, la celda sale gris/vacía). Configurable en `CONFIG.MIN_MATCHES_MATRIX`.

---

## Mantenimiento

### Cambiar de Google Sheet
El ID y el nombre de la pestaña ya **no** están en `script.js` — viven en `.github/workflows/update-data.yml`, en las variables `SHEET_ID` y `SHEET_TAB` del paso "Descargar datos de Google Sheets".

### Forzar una actualización inmediata
Pestaña **Actions** del repo → "Actualizar datos de Riftbound" → botón **"Run workflow"**. Si no, se actualiza sola cada 15 minutos.

### Añadir la foto de un jugador
Sube el archivo a `assets/imgs/` con el nombre `<nombre_normalizado>_wins.<extensión>` (minúsculas, sin tildes, espacios convertidos en `_`). Ejemplos: `alvaro_wins.jpg`, `dani_gt_wins.png`, `noe_wins.jpg`. El sistema prueba automáticamente `.jpg`, `.jpeg`, `.png` y `.webp` en ese orden. Si no encuentra la foto de alguien, usa `generic_wins.<ext>` como respaldo — si tampoco existe, simplemente no muestra imagen (sin icono roto).

### Añadir leyendas nuevas
No hace falta tocar nada — todas las listas de leyendas (selectores, matriz, ranking de battlefields, filtro de comentarios) se calculan a partir de los datos en cada carga de página.

### Editar La Porra o los Mandamientos
Son contenido fijo escrito directamente en `index.html` (secciones `#section-porra` y `#section-mandamientos`), no vienen del Sheet — se editan a mano ahí.

### Después de subir cambios en `style.css` o `script.js`
Sube también `index.html` con el número de versión del cache-buster aumentado (`style.css?v=X`, `script.js?v=X`) — evita que los navegadores sigan usando una copia vieja en caché.

---

## Solución de problemas

**La web no carga ningún dato:**
1. Comprueba en la pestaña **Actions** que la última ejecución de "Actualizar datos de Riftbound" terminó en verde ✓.
2. Si nunca se ha lanzado, hazlo a mano una vez (ver "Forzar una actualización inmediata" arriba) — así se crea `data.json` por primera vez.
3. Revisa que en **Settings → Actions → General → Workflow permissions** esté marcado "Read and write permissions" (si no, el Action no puede guardar `data.json`).

**Cambios que no se ven en la web:**
Casi siempre es caché del navegador. Recarga forzada (`Ctrl+Shift+R`) o prueba en una ventana de incógnito.

**Un jugador o leyenda sale mal en las estadísticas:**
Revisa que el texto en el Google Form coincide exactamente (mayúsculas, tildes, espacios) con lo que se compara en `script.js` — por ejemplo el texto `"No jugada"` para rondas no jugadas.
