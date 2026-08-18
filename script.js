/* ============================================================
   RIFTBOUND JGT — script.js
   Ya no se conecta a Google Sheets directamente desde el navegador
   (eso rompía con VPNs/redes que Google marca como sospechosas).
   En su lugar, lee data.json, un archivo generado periódicamente
   por una GitHub Action (.github/workflows/update-data.yml) que
   descarga la hoja desde el servidor de GitHub. Calcula en el
   navegador: leaderboard, winrate por leyenda, matriz de matchups
   y crónica de partidas recientes.
   ============================================================ */

const CONFIG = {
  // Archivo generado por la GitHub Action. Si algún día quieres
  // cambiar de hoja de Google, el SHEET_ID a editar está en
  // .github/workflows/update-data.yml, no aquí — este script.js
  // ya no habla con Google en ningún momento.
  DATA_FILE: "data.json",

  // Jugadores a excluir de todas las estadísticas (partidas de prueba, etc.)
  EXCLUDE_PLAYERS: ["Invitado"],

  // Mínimo de partidas para que un matchup se considere "fiable"
  // (por debajo de esto, la celda de la matriz aparece vacía/gris)
  MIN_MATCHES_MATRIX: 2,

  // Cuántas partidas recientes mostrar en la Crónica
  HISTORY_LIMIT: 100,

  // Carpeta donde subirás las fotos de cada jugador (la que ya
  // existe en tu repo: assets/imgs). Nombre de archivo esperado:
  // "<nombre_normalizado>_wins.<extensión>" — p.ej. "alvaro_wins.jpg".
  // Prueba automáticamente estas extensiones en este orden hasta
  // encontrar una que exista; si ninguna existe para ese jugador,
  // cae a "generic_wins.<extensión>" con el mismo orden de pruebas.
  PLAYER_IMG_PATH: "assets/imgs/",
  PLAYER_IMG_EXTS: ["jpg", "jpeg", "png", "webp"],
};

// Convierte un nombre de jugador en el slug de archivo esperado:
// minúsculas, sin tildes, sin espacios ("Dani GT" -> "dani_gt")
function slugifyName(name) {
  return String(name)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // quita tildes
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/* ============================================================
   1. Lectura de data.json (generado por la GitHub Action)
   ============================================================ */

async function fetchLocalData() {
  // Cache-bust con la hora actual: así, si alguien deja la pestaña
  // abierta un rato, un F5 siempre trae la versión más reciente de
  // data.json en vez de una copia cacheada por el navegador.
  const res = await fetch(`${CONFIG.DATA_FILE}?_=${Date.now()}`);
  if (!res.ok) throw new Error(`No se pudo leer ${CONFIG.DATA_FILE} (HTTP ${res.status}). ¿Se ha ejecutado ya la GitHub Action "Actualizar datos de Riftbound" al menos una vez?`);
  const payload = await res.json();
  if (!Array.isArray(payload.rows)) throw new Error(`${CONFIG.DATA_FILE} tiene un formato inesperado.`);
  return payload;
}

/* ============================================================
   2. Transformación: de filas crudas del formulario a
      estructuras utilizables (rondas individuales + resumen
      por partido)
   ============================================================ */

const NO_JUGADA = "No jugada";

function buildRounds(rawRows) {
  // Cada fila del formulario = 1 partido (hasta 3 rondas).
  // La "desenrollamos" en 1 fila por ronda jugada.
  const rounds = [];
  const matches = [];

  rawRows.forEach((row, matchIndex) => {
    const jugador = row["Jugador"];
    const rival = row["Rival"];
    if (!jugador || !rival) return;
    if (CONFIG.EXCLUDE_PLAYERS.includes(jugador) || CONFIG.EXCLUDE_PLAYERS.includes(rival)) return;

    const leyendaJugador = row["Leyenda Jugador"];
    const leyendaRival = row["Leyenda rival"];

    const roundDefs = [
      { resultado: row["Resultado 1ª Partida"], bfJugador: row["Battlefield Jugador (Blind)"], bfRival: row["Battlefield Oponente (Blind)"], n: 1 },
      { resultado: row["Resultado 2ª partida"], bfJugador: row["2º Battlefield Jugador "] ?? row["2º Battlefield Jugador"], bfRival: row["2º Battlefield Oponente"], n: 2 },
      { resultado: row["Resultado 3ª partida"], bfJugador: row["3º Battlefield Jugador"], bfRival: row["3º Battlefield Oponente"], n: 3 },
    ];

    let jugadas = 0, victoriasJugador = 0, victoriasRival = 0;

    roundDefs.forEach(rd => {
      if (!rd.resultado || rd.resultado === NO_JUGADA) return;
      jugadas++;
      if (rd.resultado === "Victoria") victoriasJugador++;
      else if (rd.resultado === "Derrota") victoriasRival++;

      rounds.push({
        matchIndex,
        marca: row["Marca temporal"],
        jugador, rival,
        leyendaJugador, leyendaRival,
        ronda: rd.n,
        resultado: rd.resultado, // Victoria / Derrota / Empate (desde el punto de vista de "Jugador")
        battlefieldJugador: rd.bfJugador,
        battlefieldRival: rd.bfRival,
      });
    });

    if (jugadas === 0) return;

    const formato = jugadas <= 1 ? "BO1" : "BO3";
    let ganador;
    if (victoriasJugador > victoriasRival) ganador = jugador;
    else if (victoriasRival > victoriasJugador) ganador = rival;
    else ganador = null; // empate de partido

    matches.push({
      matchIndex, marca: row["Marca temporal"],
      jugador, rival, leyendaJugador, leyendaRival,
      formato, jugadas, victoriasJugador, victoriasRival, ganador,
      notas: row["Notas / Observaciones"],
      amenazas: row["Amenazas a tener en cuenta"],
      sideboardOtp: row["Sideboard OTP"],
      sideboardOtd: row["Sideboard OTD"],
    });
  });

  return { rounds, matches };
}

/* ============================================================
   3. Cálculos: leaderboard, winrate por leyenda, matriz
   ============================================================ */

function computeLeaderboard(matches) {
  const stats = {}; // nombre -> {jugados, ganados, perdidos, empatados}

  function ensure(name) {
    if (!stats[name]) stats[name] = { jugados: 0, ganados: 0, perdidos: 0, empatados: 0 };
    return stats[name];
  }

  matches.forEach(m => {
    const a = ensure(m.jugador);
    const b = ensure(m.rival);
    a.jugados++; b.jugados++;
    if (m.ganador === m.jugador) { a.ganados++; b.perdidos++; }
    else if (m.ganador === m.rival) { b.ganados++; a.perdidos++; }
    else { a.empatados++; b.empatados++; }
  });

  return Object.entries(stats)
    .map(([nombre, s]) => ({ nombre, ...s, winrate: s.jugados ? s.ganados / s.jugados : 0 }))
    .sort((x, y) => y.winrate - x.winrate || y.jugados - x.jugados);
}

function computeLeyendaWinrate(rounds) {
  // Simétrico: cada ronda genera 2 registros (leyenda jugador / leyenda rival),
  // igual que hacíamos en Sheets con Matchups_leyendas.
  const stats = {};
  function ensure(name) {
    if (!stats[name]) stats[name] = { jugadas: 0, victorias: 0 };
    return stats[name];
  }

  rounds.forEach(r => {
    if (r.resultado === "Empate" || !r.leyendaJugador || !r.leyendaRival) return;
    const a = ensure(r.leyendaJugador);
    a.jugadas++;
    if (r.resultado === "Victoria") a.victorias++;

    const b = ensure(r.leyendaRival);
    b.jugadas++;
    if (r.resultado === "Derrota") b.victorias++;
  });

  return Object.entries(stats)
    .map(([leyenda, s]) => ({ leyenda, ...s, winrate: s.jugadas ? s.victorias / s.jugadas : 0 }))
    .sort((x, y) => y.winrate - x.winrate);
}

function computeMatchupMatrix(rounds) {
  // pares[A][B] = {jugadas, victorias} desde la perspectiva de A contra B
  const pares = {};
  const leyendas = new Set();

  function ensure(a, b) {
    pares[a] = pares[a] || {};
    pares[a][b] = pares[a][b] || { jugadas: 0, victorias: 0 };
    return pares[a][b];
  }

  rounds.forEach(r => {
    if (r.resultado === "Empate" || !r.leyendaJugador || !r.leyendaRival) return;
    leyendas.add(r.leyendaJugador);
    leyendas.add(r.leyendaRival);

    const ab = ensure(r.leyendaJugador, r.leyendaRival);
    ab.jugadas++;
    if (r.resultado === "Victoria") ab.victorias++;

    const ba = ensure(r.leyendaRival, r.leyendaJugador);
    ba.jugadas++;
    if (r.resultado === "Derrota") ba.victorias++;
  });

  const lista = Array.from(leyendas).sort((a, b) => a.localeCompare(b, "es"));
  return { leyendas: lista, pares };
}

/* ============================================================
   4. Render
   ============================================================ */

function fmtPct(x) {
  return `${Math.round(x * 100)}%`;
}

function renderKPIs({ matches, leaderboard, leyendaWinrate }) {
  const el = document.getElementById("kpi-row");
  const totalPartidas = matches.length;
  const lider = leaderboard[0];
  const leyendaTop = [...leyendaWinrate].sort((a, b) => b.jugadas - a.jugadas)[0];
  const bo1 = matches.filter(m => m.formato === "BO1").length;
  const bo3 = matches.filter(m => m.formato === "BO3").length;

  el.innerHTML = `
    <div class="kpi">
      <span class="kpi__value">${totalPartidas}</span>
      <span class="kpi__label">Partidas registradas</span>
    </div>
    <div class="kpi">
      <span class="kpi__value">${lider ? escapeHtml(lider.nombre) : "—"}</span>
      <span class="kpi__label">Jugador líder ${lider ? `(${fmtPct(lider.winrate)})` : ""}</span>
    </div>
    <div class="kpi">
      <span class="kpi__value">${leyendaTop ? escapeHtml(leyendaTop.leyenda) : "—"}</span>
      <span class="kpi__label">Leyenda más jugada</span>
    </div>
    <div class="kpi">
      <span class="kpi__value">${bo1} / ${bo3}</span>
      <span class="kpi__label">Formato BO1 / BO3</span>
    </div>
  `;

  renderLeaderSpotlight(lider, matches);
  renderRunnersUp(leaderboard);
}

function renderRunnersUp(leaderboard) {
  const el = document.getElementById("runners-up");
  if (!el) return;

  const runners = leaderboard.slice(1, 3); // 2º y 3º puesto
  if (!runners.length) { el.innerHTML = ""; return; }

  el.innerHTML = runners.map((p, i) => {
    const rank = i + 2;
    const record = `${p.ganados}V - ${p.perdidos}D${p.empatados ? ` - ${p.empatados}E` : ""}`;
    return `
      <div class="runner-card">
        <span class="runner-card__rank">${rank}</span>
        <div class="runner-card__body">
          <span class="runner-card__name">${escapeHtml(p.nombre)}</span>
          <span class="runner-card__stats">${record} · ${p.jugados} partidas</span>
        </div>
        <span class="runner-card__pct">${fmtPct(p.winrate)}</span>
      </div>
    `;
  }).join("");
}

function computeFavoriteLegend(matches, playerName) {
  const counts = {};
  matches.forEach(m => {
    if (m.jugador === playerName && m.leyendaJugador) {
      counts[m.leyendaJugador] = (counts[m.leyendaJugador] || 0) + 1;
    }
    if (m.rival === playerName && m.leyendaRival) {
      counts[m.leyendaRival] = (counts[m.leyendaRival] || 0) + 1;
    }
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return entries.length ? { leyenda: entries[0][0], veces: entries[0][1] } : null;
}

function renderLeaderSpotlight(lider, matches) {
  const el = document.getElementById("leader-spotlight");
  if (!el) return;

  if (!lider) { el.innerHTML = ""; return; }

  const candidates = buildPlayerImgCandidates(slugifyName(lider.nombre));
  const fallbackCandidates = buildPlayerImgCandidates("generic");
  const allCandidates = [...candidates, ...fallbackCandidates];

  const favLegend = computeFavoriteLegend(matches, lider.nombre);
  const record = `${lider.ganados}V - ${lider.perdidos}D${lider.empatados ? ` - ${lider.empatados}E` : ""}`;

  el.innerHTML = `
    <img class="leader-spotlight__img" id="leader-spotlight-img" src="${allCandidates[0]}" alt="${escapeHtml(lider.nombre)}">
    <div class="leader-spotlight__info">
      <span class="leader-spotlight__label">Jugador líder</span>
      <span class="leader-spotlight__name">${escapeHtml(lider.nombre)}</span>
      <span class="leader-spotlight__pct">${fmtPct(lider.winrate)} de victorias · ${lider.jugados} partidas</span>
      <div class="leader-spotlight__stats">
        <span class="leader-spotlight__stat"><b>${record}</b></span>
        ${favLegend ? `<span class="leader-spotlight__stat">Leyenda favorita: <b>${escapeHtml(favLegend.leyenda)}</b> · ${favLegend.veces}p</span>` : ""}
      </div>
    </div>
  `;

  const img = document.getElementById("leader-spotlight-img");
  if (img) wireImageFallbackChain(img, allCandidates);
}

function buildPlayerImgCandidates(nameSlug) {
  return CONFIG.PLAYER_IMG_EXTS.map(ext => `${CONFIG.PLAYER_IMG_PATH}${nameSlug}_wins.${ext}`);
}

// Prueba cada URL de la lista en orden; si todas fallan, oculta la
// imagen en vez de mostrar el icono de "imagen rota".
function wireImageFallbackChain(imgEl, sources) {
  let idx = 0;
  imgEl.addEventListener("error", () => {
    idx++;
    if (idx < sources.length) {
      imgEl.src = sources[idx];
    } else {
      imgEl.style.display = "none";
    }
  });
}

function renderLeaderboard(leaderboard) {
  const el = document.getElementById("leaderboard");
  if (!leaderboard.length) {
    el.innerHTML = `<div class="loading-row">Aún no hay partidas registradas.</div>`;
    return;
  }

  el.innerHTML = leaderboard.map((p, i) => `
    <div class="leaderboard__row leaderboard__row--${i + 1}">
      <span class="leaderboard__rank">${i + 1}</span>
      <span class="leaderboard__name">${escapeHtml(p.nombre)}</span>
      <span class="leaderboard__record">${p.ganados}V - ${p.perdidos}D${p.empatados ? ` - ${p.empatados}E` : ""} · ${p.jugados} partidas</span>
      <span class="leaderboard__bar-wrap"><span class="leaderboard__bar" style="width:${Math.round(p.winrate * 100)}%"></span></span>
      <span class="leaderboard__pct">${fmtPct(p.winrate)}</span>
    </div>
  `).join("");
}

function renderLeyendas(leyendaWinrate) {
  const el = document.getElementById("leyendas-chart");
  if (!leyendaWinrate.length) {
    el.innerHTML = `<div class="loading-row">Sin datos suficientes.</div>`;
    return;
  }

  el.innerHTML = leyendaWinrate.map(l => {
    const color = colorForWinrate(l.winrate);
    return `
      <div class="leyenda-row">
        <span class="leyenda-row__name">${escapeHtml(l.leyenda)}</span>
        <span class="leyenda-row__track">
          <span class="leyenda-row__fill" style="width:${Math.round(l.winrate * 100)}%; background:${color}"></span>
        </span>
        <span class="leyenda-row__stats"><b>${fmtPct(l.winrate)}</b> · ${l.jugadas}p</span>
      </div>
    `;
  }).join("");
}

function colorForWinrate(w, highColor) {
  // degradado directo carmesí (0) -> color de destino (1)
  const crimson = [196, 82, 78];
  const high = highColor || [216, 176, 58]; // dorado por defecto
  const rgb = crimson.map((v, i) => Math.round(v + (high[i] - v) * w));
  return `rgb(${rgb.join(",")})`;
}

// Verde/teal de "victoria" — más representativo que el dorado cuando
// el winrate se acerca al 100%, usado solo en la cuadrícula de matchups.
const VICTORY_COLOR = [45, 196, 140];

function renderMatrix({ leyendas, pares }) {
  const wrap = document.getElementById("matrix-wrap");
  if (!leyendas.length) {
    wrap.innerHTML = `<div class="loading-row">Sin datos suficientes.</div>`;
    return;
  }

  let html = `<table class="matrix"><thead><tr><th></th>`;
  leyendas.forEach(l => { html += `<th>${escapeHtml(l)}</th>`; });
  html += `</tr></thead><tbody>`;

  leyendas.forEach(a => {
    html += `<tr><th>${escapeHtml(a)}</th>`;
    leyendas.forEach(b => {
      if (a === b) { html += `<td class="cell cell--empty">–</td>`; return; }
      const cell = pares[a] && pares[a][b];
      if (!cell || cell.jugadas < CONFIG.MIN_MATCHES_MATRIX) {
        const info = cell ? `${cell.victorias}/${cell.jugadas}` : "0/0";
        html += `<td class="cell cell--empty" title="${escapeHtml(a)} vs ${escapeHtml(b)}: ${info} partidas">–</td>`;
        return;
      }
      const wr = cell.victorias / cell.jugadas;
      const color = colorForWinrate(wr, VICTORY_COLOR);
      html += `<td class="cell" style="background:${color}" title="${escapeHtml(a)} vs ${escapeHtml(b)}: ${fmtPct(wr)} (${cell.victorias}/${cell.jugadas})">${Math.round(wr * 100)}</td>`;
    });
    html += `</tr>`;
  });

  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

function renderHistory(matches) {
  const el = document.getElementById("history");
  if (!matches.length) {
    el.innerHTML = `<div class="loading-row">Aún no hay partidas registradas.</div>`;
    return;
  }

  const recent = [...matches].reverse().slice(0, CONFIG.HISTORY_LIMIT);

  el.innerHTML = recent.map(m => {
    let scoreClass = "draw", scoreLabel = "Empate";
    if (m.ganador === m.jugador) { scoreClass = "win"; scoreLabel = `Gana ${m.jugador}`; }
    else if (m.ganador === m.rival) { scoreClass = "loss"; scoreLabel = `Gana ${m.rival}`; }

    const fecha = m.marca ? formatFecha(m.marca) : "";

    return `
      <div class="history__item">
        <span class="history__date">${fecha}<br>${m.formato}</span>
        <span class="history__matchup">
          <b>${escapeHtml(m.jugador)}</b> (${escapeHtml(m.leyendaJugador || "?")}) <span class="vs">vs</span>
          <b>${escapeHtml(m.rival)}</b> (${escapeHtml(m.leyendaRival || "?")})
        </span>
        <span class="history__score history__score--${scoreClass}">${escapeHtml(scoreLabel)} · ${m.victoriasJugador}-${m.victoriasRival}</span>
      </div>
    `;
  }).join("");
}

function getAllLeyendas(matches) {
  // Se deriva de los datos en cada carga, así que una leyenda nueva
  // aparece sola en el filtro sin tocar el código.
  const set = new Set();
  matches.forEach(m => {
    if (m.leyendaJugador) set.add(m.leyendaJugador);
    if (m.leyendaRival) set.add(m.leyendaRival);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

function buildCommentCard(m) {
  const fecha = m.marca ? formatFecha(m.marca) : "";
  const rows = [];

  if (m.notas && String(m.notas).trim()) {
    rows.push(`
      <div class="comment-card__row">
        <span class="comment-card__tag">Nota</span>
        <span>${escapeHtml(m.notas)}</span>
      </div>
    `);
  }
  if (m.amenazas && String(m.amenazas).trim()) {
    rows.push(`
      <div class="comment-card__row comment-card__row--amenaza">
        <span class="comment-card__tag">Amenaza</span>
        <span>${escapeHtml(m.amenazas)}</span>
      </div>
    `);
  }
  if (m.sideboardOtp && String(m.sideboardOtp).trim()) {
    rows.push(`
      <div class="comment-card__row comment-card__row--sideboard">
        <span class="comment-card__tag comment-card__tag--sideboard">Sideboard OTP</span>
        <span>${escapeHtml(m.sideboardOtp)}</span>
      </div>
    `);
  }
  if (m.sideboardOtd && String(m.sideboardOtd).trim()) {
    rows.push(`
      <div class="comment-card__row comment-card__row--sideboard">
        <span class="comment-card__tag comment-card__tag--sideboard">Sideboard OTD</span>
        <span>${escapeHtml(m.sideboardOtd)}</span>
      </div>
    `);
  }

  return `
    <div class="comment-card">
      <div class="comment-card__head">
        <span class="comment-card__matchup">
          <b>${escapeHtml(m.jugador)}</b> (${escapeHtml(m.leyendaJugador || "?")}) <span class="vs">vs</span>
          <b>${escapeHtml(m.rival)}</b> (${escapeHtml(m.leyendaRival || "?")})
        </span>
        <span class="comment-card__date">${fecha}</span>
      </div>
      <div class="comment-card__body">${rows.join("")}</div>
    </div>
  `;
}

function renderComments(matches) {
  const el = document.getElementById("comments");

  const withNotes = [...matches]
    .reverse()
    .filter(m => (m.notas && String(m.notas).trim()) || (m.amenazas && String(m.amenazas).trim()));

  if (!withNotes.length) {
    el.innerHTML = `<div class="loading-row">Nadie ha dejado anotaciones todavía.</div>`;
    return;
  }

  const leyendasEnComentarios = getAllLeyendas(withNotes);

  el.innerHTML = `
    <div class="comments-filter">
      <label for="comments-filter-select">Filtrar por leyenda</label>
      <select id="comments-filter-select">
        <option value="">Todas las leyendas</option>
        ${leyendasEnComentarios.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("")}
      </select>
    </div>
    <div id="comments-list"></div>
  `;

  const listEl = document.getElementById("comments-list");
  const select = document.getElementById("comments-filter-select");

  function paintList(filterLeyenda) {
    const filtered = filterLeyenda
      ? withNotes.filter(m => m.leyendaJugador === filterLeyenda || m.leyendaRival === filterLeyenda)
      : withNotes;

    if (!filtered.length) {
      listEl.innerHTML = `<div class="loading-row">Nadie ha anotado nada sobre ${escapeHtml(filterLeyenda)} todavía.</div>`;
      return;
    }

    listEl.innerHTML = filtered.map(buildCommentCard).join("");
  }

  select.addEventListener("change", () => paintList(select.value));
  paintList("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = String(str);
  return div.innerHTML;
}

function formatFecha(v) {
  // gviz puede devolver fechas como "Date(2026,6,27,20,59,23)" en el valor crudo,
  // o ya formateadas si venían como texto. Cubrimos ambos casos.
  if (typeof v === "string" && v.startsWith("Date(")) {
    const parts = v.match(/\d+/g).map(Number);
    const d = new Date(parts[0], parts[1], parts[2]);
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
  }
  return String(v);
}

/* ============================================================
   5. Pestañas
   ============================================================ */

function setupTabs() {
  const buttons = Array.from(document.querySelectorAll(".tabs__btn[data-target]"));
  const moreItems = Array.from(document.querySelectorAll(".tabs__more-item"));
  const allTargetButtons = [...buttons, ...moreItems];
  const views = Array.from(document.querySelectorAll(".view"));

  const moreTrigger = document.getElementById("tabs-more-trigger");
  const moreMenu = document.getElementById("tabs-more-menu");
  const moreTargets = moreItems.map(b => b.dataset.target);

  function closeMore() {
    if (!moreMenu || moreMenu.hidden) return;
    moreMenu.hidden = true;
    if (moreTrigger) moreTrigger.setAttribute("aria-expanded", "false");
  }

  function openMore() {
    if (!moreMenu || !moreTrigger) return;
    // Posicionamos con "fixed" calculado en JS en vez de un simple
    // position:absolute, porque la barra de pestañas tiene scroll
    // horizontal (overflow-x) y eso recortaría un menú anidado dentro.
    const rect = moreTrigger.getBoundingClientRect();
    moreMenu.style.left = `${Math.round(rect.left)}px`;
    moreMenu.style.top = `${Math.round(rect.bottom + 6)}px`;
    moreMenu.hidden = false;
    moreTrigger.setAttribute("aria-expanded", "true");
  }

  function activate(targetId, updateHash) {
    views.forEach(v => v.classList.toggle("view--active", v.id === targetId));
    allTargetButtons.forEach(b => b.setAttribute("aria-selected", String(b.dataset.target === targetId)));
    if (moreTrigger) moreTrigger.setAttribute("aria-selected", String(moreTargets.includes(targetId)));
    if (updateHash) history.replaceState(null, "", `#${targetId}`);
    closeMore();
  }

  allTargetButtons.forEach(btn => {
    btn.addEventListener("click", () => activate(btn.dataset.target, true));
  });

  if (moreTrigger && moreMenu) {
    moreTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      if (moreMenu.hidden) openMore(); else closeMore();
    });
    document.addEventListener("click", (e) => {
      if (!moreMenu.hidden && !moreMenu.contains(e.target) && e.target !== moreTrigger) closeMore();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMore(); });
    window.addEventListener("resize", closeMore);
  }

  const fromHash = window.location.hash.replace("#", "");
  const validIds = views.map(v => v.id);
  if (validIds.includes(fromHash)) {
    activate(fromHash, false);
  }
}

/* ============================================================
   6. Gameplan — matchups de una leyenda + amenazas al hacer clic
   ============================================================ */

function renderGameplan(matrix, matches) {
  const select = document.getElementById("gameplan-select");
  const results = document.getElementById("gameplan-results");
  if (!select || !results) return;

  const leyendas = matrix.leyendas;
  select.innerHTML = `<option value="">Elige una leyenda…</option>` +
    leyendas.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");

  const amenazaCounts = computeAmenazaCountsByLeyenda(matches);

  function paint(sel) {
    const detail = document.getElementById("gameplan-detail");
    if (detail) detail.hidden = true;

    if (!sel) {
      results.innerHTML = `<div class="gameplan-empty">Elige tu leyenda arriba para ver cómo le va contra cada rival.</div>`;
      return;
    }

    const pares = matrix.pares[sel] || {};
    const rows = leyendas
      .filter(l => l !== sel)
      .map(l => {
        const cell = pares[l];
        const jugadas = cell ? cell.jugadas : 0;
        const winrate = jugadas ? cell.victorias / jugadas : null;
        return { leyenda: l, jugadas, winrate };
      })
      .sort((a, b) => {
        if (a.winrate === null && b.winrate === null) return a.leyenda.localeCompare(b.leyenda, "es");
        if (a.winrate === null) return 1;
        if (b.winrate === null) return -1;
        return b.winrate - a.winrate;
      });

    results.innerHTML = rows.map(r => {
      const amenazas = amenazaCounts[r.leyenda] || 0;
      const color = r.winrate === null ? null : colorForWinrate(r.winrate, VICTORY_COLOR);
      return `
        <div class="gameplan-row${r.winrate === null ? " gameplan-row--nodata" : ""}" data-leyenda="${escapeHtml(r.leyenda)}" tabindex="0" role="button">
          <span class="gameplan-row__name">${escapeHtml(r.leyenda)}</span>
          <span class="gameplan-row__track">
            ${r.winrate !== null ? `<span class="gameplan-row__fill" style="width:${Math.round(r.winrate * 100)}%; background:${color}"></span>` : ""}
          </span>
          <span class="gameplan-row__pct">${r.winrate !== null ? `${fmtPct(r.winrate)} · ${r.jugadas}p` : "Sin datos"}</span>
          <span class="gameplan-row__badge${amenazas ? "" : " gameplan-row__badge--empty"}">${amenazas ? `⚠ ${amenazas}` : "Sin amenazas"}</span>
        </div>
      `;
    }).join("");

    results.querySelectorAll(".gameplan-row").forEach(row => {
      const open = () => renderGameplanDetail(sel, row.dataset.leyenda, matches);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  }

  select.addEventListener("change", () => paint(select.value));
  paint("");
}

function computeAmenazaCountsByLeyenda(matches) {
  const counts = {};
  matches.forEach(m => {
    if (!(m.amenazas && String(m.amenazas).trim())) return;
    if (m.leyendaJugador) counts[m.leyendaJugador] = (counts[m.leyendaJugador] || 0) + 1;
    if (m.leyendaRival) counts[m.leyendaRival] = (counts[m.leyendaRival] || 0) + 1;
  });
  return counts;
}

function renderGameplanDetail(myLeyenda, enemyLeyenda, matches) {
  const el = document.getElementById("gameplan-detail");
  if (!el) return;

  const reversed = [...matches].reverse();

  function buildEntry(m, field) {
    const fecha = m.marca ? formatFecha(m.marca) : "";
    return `
      <div class="gameplan-detail__entry">
        <span class="gameplan-detail__entry-meta">
          <b>${escapeHtml(m.jugador)}</b> (${escapeHtml(m.leyendaJugador || "?")}) vs
          <b>${escapeHtml(m.rival)}</b> (${escapeHtml(m.leyendaRival || "?")}) · ${fecha}
        </span>
        <p class="gameplan-detail__entry-text">${escapeHtml(m[field])}</p>
      </div>
    `;
  }

  // Una amenaza la escribe "Jugador" sobre "Rival" — describe al rival,
  // no a quien la escribe. Por eso aquí sí importa la dirección:
  function tiersForAmenazas() {
    const has = m => m.amenazas && String(m.amenazas).trim();
    return [
      {
        // Lo más útil: lo que anotaste jugando tu leyenda contra esta rival.
        title: `Jugando ${myLeyenda} contra ${enemyLeyenda}`,
        entries: reversed.filter(m => has(m) && m.leyendaJugador === myLeyenda && m.leyendaRival === enemyLeyenda),
        empty: "Nada anotado en este matchup todavía.",
      },
      {
        // Distinto: esto describe tu leyenda, no a la rival — lo separamos.
        title: `Anotado sobre ${myLeyenda} (jugando ${enemyLeyenda})`,
        entries: reversed.filter(m => has(m) && m.leyendaJugador === enemyLeyenda && m.leyendaRival === myLeyenda),
        empty: "Nada anotado todavía.",
        secondary: true,
      },
      {
        // Menos relevante: esta leyenda rival contra cualquier otra.
        title: `${enemyLeyenda} contra otras leyendas`,
        entries: reversed.filter(m => has(m) && m.leyendaRival === enemyLeyenda && m.leyendaJugador !== myLeyenda),
        empty: "Nada más anotado.",
        secondary: true,
      },
    ];
  }

  // Las notas son más libres (no siempre "sobre el rival"), así que
  // aquí mantenemos el criterio anterior: el enfrentamiento directo
  // primero, y el resto de menciones a esta leyenda después.
  function tiersForNotas() {
    const has = m => m.notas && String(m.notas).trim();
    const related = reversed.filter(m => has(m) && (m.leyendaJugador === enemyLeyenda || m.leyendaRival === enemyLeyenda));
    const specific = related.filter(m =>
      (m.leyendaJugador === myLeyenda && m.leyendaRival === enemyLeyenda) ||
      (m.leyendaJugador === enemyLeyenda && m.leyendaRival === myLeyenda)
    );
    const specificSet = new Set(specific);
    const general = related.filter(m => !specificSet.has(m));
    return [
      { title: `Contra ${myLeyenda}`, entries: specific, empty: "Nada anotado en este matchup todavía." },
      { title: `Contra otras leyendas`, entries: general, empty: "Nada más anotado.", secondary: true },
    ];
  }

  function buildColumn(field, tiers) {
    return tiers.map(t => `
      <div class="gameplan-detail__tier${t.secondary ? " gameplan-detail__tier--secondary" : ""}">
        <h5 class="gameplan-detail__tier-title">${escapeHtml(t.title)}</h5>
        ${t.entries.length ? t.entries.map(m => buildEntry(m, field)).join("") : `<div class="gameplan-detail__empty">${t.empty}</div>`}
      </div>
    `).join("");
  }

  el.innerHTML = `
    <h3 class="gameplan-detail__title">Sobre ${escapeHtml(enemyLeyenda)}</h3>
    <div class="gameplan-detail__cols">
      <div>
        <h4 class="gameplan-detail__col-title gameplan-detail__col-title--amenazas">Amenazas</h4>
        ${buildColumn("amenazas", tiersForAmenazas())}
      </div>
      <div>
        <h4 class="gameplan-detail__col-title gameplan-detail__col-title--notas">Notas</h4>
        ${buildColumn("notas", tiersForNotas())}
      </div>
    </div>
  `;
  el.hidden = false;
}

/* ============================================================
   7. Battlefields
   ============================================================ */

function computeBattlefieldStats(rounds) {
  const overallCounts = {};
  const byLeyenda = {}; // leyenda -> { battlefield: count }

  function addOverall(bf) {
    if (!bf) return;
    overallCounts[bf] = (overallCounts[bf] || 0) + 1;
  }
  function addByLeyenda(leyenda, bf) {
    if (!leyenda || !bf) return;
    byLeyenda[leyenda] = byLeyenda[leyenda] || {};
    byLeyenda[leyenda][bf] = (byLeyenda[leyenda][bf] || 0) + 1;
  }

  // Cada ronda tiene su propio battlefield por lado — se cuenta el
  // del jugador y el del rival como dos elecciones independientes.
  rounds.forEach(r => {
    addOverall(r.battlefieldJugador);
    addOverall(r.battlefieldRival);
    addByLeyenda(r.leyendaJugador, r.battlefieldJugador);
    addByLeyenda(r.leyendaRival, r.battlefieldRival);
  });

  const toSortedList = counts => Object.entries(counts)
    .map(([battlefield, count]) => ({ battlefield, count }))
    .sort((a, b) => b.count - a.count);

  const byLeyendaSorted = {};
  Object.entries(byLeyenda).forEach(([leyenda, counts]) => {
    byLeyendaSorted[leyenda] = toSortedList(counts);
  });

  return { overall: toSortedList(overallCounts), byLeyenda: byLeyendaSorted };
}

function renderBattlefieldBars(container, list) {
  if (!list.length) {
    container.innerHTML = `<div class="gameplan-empty">Sin datos todavía.</div>`;
    return;
  }
  const max = list[0].count;
  container.innerHTML = list.map(item => `
    <div class="bf-row">
      <span class="bf-row__name">${escapeHtml(item.battlefield)}</span>
      <span class="bf-row__track"><span class="bf-row__fill" style="width:${Math.round(item.count / max * 100)}%"></span></span>
      <span class="bf-row__stats"><b>${item.count}</b> ${item.count === 1 ? "vez" : "veces"}</span>
    </div>
  `).join("");
}

function renderBattlefields(stats) {
  const overallEl = document.getElementById("bf-ranking");
  const legendSelect = document.getElementById("bf-legend-select");
  const legendRankingEl = document.getElementById("bf-legend-ranking");
  if (!overallEl || !legendSelect || !legendRankingEl) return;

  renderBattlefieldBars(overallEl, stats.overall);

  const leyendasConDatos = Object.keys(stats.byLeyenda).sort((a, b) => a.localeCompare(b, "es"));
  legendSelect.innerHTML = `<option value="">Elige una leyenda…</option>` +
    leyendasConDatos.map(l => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");

  legendSelect.addEventListener("change", () => {
    const sel = legendSelect.value;
    if (!sel) {
      legendRankingEl.innerHTML = `<div class="gameplan-empty">Elige una leyenda para ver sus battlefields más jugados.</div>`;
      return;
    }
    renderBattlefieldBars(legendRankingEl, stats.byLeyenda[sel] || []);
  });
}

/* ============================================================
   8. Init
   ============================================================ */

async function init() {
  setupTabs();

  try {
    const payload = await fetchLocalData();
    const { rounds, matches } = buildRounds(payload.rows);

    const leaderboard = computeLeaderboard(matches);
    const leyendaWinrate = computeLeyendaWinrate(rounds);
    const matrix = computeMatchupMatrix(rounds);
    const bfStats = computeBattlefieldStats(rounds);

    renderKPIs({ matches, leaderboard, leyendaWinrate });
    renderLeaderboard(leaderboard);
    renderLeyendas(leyendaWinrate);
    renderBattlefields(bfStats);
    renderMatrix(matrix);
    renderHistory(matches);
    renderComments(matches);
    renderGameplan(matrix, matches);
    renderFooterTimestamp(payload.generatedAt);

  } catch (err) {
    console.error(err);
    document.querySelectorAll(".loading-row").forEach(el => {
      el.textContent = "No se pudieron cargar los datos. Comprueba en la pestaña 'Actions' del repo que la tarea 'Actualizar datos de Riftbound' se haya ejecutado correctamente.";
    });
  }
}

function renderFooterTimestamp(generatedAt) {
  const el = document.getElementById("footer-updated");
  if (!el || !generatedAt) return;
  const d = new Date(generatedAt);
  const texto = d.toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  el.textContent = `· Última actualización de los datos: ${texto}`;
}

init();
