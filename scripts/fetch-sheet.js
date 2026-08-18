#!/usr/bin/env node
/**
 * Descarga los datos de Google Sheets (vía la API de Google
 * Visualization, "gviz") y los guarda en data.json en la raíz del
 * repo, con el mismo formato de filas que antes leía script.js
 * directamente del navegador.
 *
 * Se ejecuta desde GitHub Actions (ver .github/workflows/update-data.yml),
 * NUNCA desde el navegador del visitante — por eso no le afecta
 * ninguna VPN ni bloqueo de red que tenga quien visite la web: la IP
 * que consulta a Google es la del runner de GitHub, no la del visitante.
 */

const fs = require("fs");
const path = require("path");

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || "Respuestas_formulario";

if (!SHEET_ID) {
  console.error("Falta la variable de entorno SHEET_ID.");
  process.exit(1);
}

async function main() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(SHEET_TAB)}`;

  // Timeout de seguridad: sin esto, un fallo de red raro dejaría el
  // Action colgado consumiendo minutos de Actions hasta el límite
  // por defecto de GitHub (varias horas) en vez de fallar rápido.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);

  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error("Tiempo de espera agotado (20s) al conectar con Google Sheets.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} al leer la hoja "${SHEET_TAB}". Revisa SHEET_ID y que la hoja tenga permiso de lectura para "cualquiera con el enlace".`);
  }

  const text = await res.text();

  // La respuesta viene envuelta en: google.visualization.Query.setResponse({...});
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error("Respuesta inesperada de Google (¿el ID de la hoja es correcto? ¿tiene permisos de lectura?).");
  }

  const data = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  if (!data.table || !Array.isArray(data.table.cols) || !Array.isArray(data.table.rows)) {
    throw new Error(`La respuesta de Google no tiene el formato esperado (¿existe la pestaña "${SHEET_TAB}"?).`);
  }

  const labels = data.table.cols.map(c => (c.label || "").trim());

  const rows = data.table.rows
    .map(r => {
      const obj = {};
      labels.forEach((label, i) => {
        const cell = r.c && r.c[i];
        obj[label] = cell ? (cell.f !== undefined && cell.f !== null ? cell.f : cell.v) : null;
      });
      return obj;
    })
    .filter(row => Object.values(row).some(v => v !== null && v !== ""));

  // Si Google devuelve 0 filas es casi siempre un problema pasajero
  // (permisos, pestaña renombrada...), no que el grupo haya borrado
  // todas sus partidas. Mejor fallar y conservar el data.json anterior
  // que sobrescribirlo con algo vacío.
  if (rows.length === 0) {
    throw new Error("La hoja devolvió 0 filas — no se sobrescribe data.json por seguridad. Si de verdad no hay partidas todavía, ignora este aviso.");
  }

  const output = {
    generatedAt: new Date().toISOString(),
    rows,
  };

  const outPath = path.join(__dirname, "..", "data.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`OK: ${rows.length} filas guardadas en data.json`);
}

main().catch(err => {
  console.error("Error actualizando data.json:", err.message);
  // Salimos con código de error para que el Action falle de forma
  // visible en vez de sobrescribir data.json con algo vacío o roto.
  process.exit(1);
});
