import express from "express";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const BROWSERLESS_WS = process.env.BROWSERLESS_WS;

function normalizeFecha(fecha) {
  if (!fecha) return "";
  const f = String(fecha).trim();

  let m = f.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;

  m = f.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;

  return f;
}

function normalizeImporte(total) {
  if (total === null || total === undefined || total === "") return "";
  const n = Number(total);
  if (Number.isNaN(n)) return String(total).trim();
  return n.toFixed(2);
}

app.get("/health", async (_req, res) => {
  res.json({ ok: true });
});

app.post("/consultar-sunat", async (req, res) => {
  const {
    external_id,
    ruc_proveedor,
    sunat_tipo_comprobante_web,
    sunat_serie_web,
    sunat_numero_web,
    sunat_fecha_web,
    sunat_total_web
  } = req.body || {};

  if (
    !external_id ||
    !ruc_proveedor ||
    !sunat_tipo_comprobante_web ||
    !sunat_serie_web ||
    !sunat_numero_web ||
    !sunat_fecha_web ||
    !sunat_total_web
  ) {
    return res.status(400).json({
      ok: false,
      external_id: external_id || null,
      resultado: "ERROR_CONSULTA",
      estado_comprobante: "DATOS_INCOMPLETOS",
      mensaje: "Faltan datos mínimos para consulta SUNAT"
    });
  }

  let browser;
  let context;
  let page;

  try {
    browser = await chromium.connectOverCDP(BROWSERLESS_WS);

    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 1366, height: 768 }
    });

    page = await context.newPage();

    const targetUrl =
      "https://e-consulta.sunat.gob.pe/ol-ti-itconsvalicpe/ConsValiCpe.htm";

    let loaded = false;
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.goto(targetUrl, {
          waitUntil: "domcontentloaded",
          timeout: 120000
        });
        loaded = true;
        break;
      } catch (err) {
        lastError = err;
        await page.waitForTimeout(3000 * attempt);
      }
    }

    if (!loaded) {
      throw new Error(
        `No se pudo abrir SUNAT después de 3 intentos. ${lastError?.message || ""}`
      );
    }

    const fecha = normalizeFecha(sunat_fecha_web);
    const importe = normalizeImporte(sunat_total_web);

    await page.fill(
      'input[name*="numRuc"], input[id*="ruc"], input[name*="ruc"]',
      String(ruc_proveedor)
    );

    await page.selectOption(
      'select[name*="codComp"], select[id*="codComp"], select[name*="tipo"]',
      String(sunat_tipo_comprobante_web)
    );

    await page.fill(
      'input[name*="numSerie"], input[id*="serie"], input[name*="serie"]',
      String(sunat_serie_web).trim()
    );

    await page.fill(
      'input[name*="numCpe"], input[id*="numero"], input[name*="numero"]',
      String(sunat_numero_web).trim()
    );

    await page.fill(
      'input[name*="fecEmision"], input[id*="fecha"], input[name*="fecha"]',
      fecha
    );

    await page.fill(
      'input[name*="mtoImporte"], input[id*="importe"], input[name*="importe"]',
      importe
    );

    await Promise.all([
      page.click(
        'button[type="submit"], input[type="submit"], button:has-text("Consultar"), button:has-text("Buscar")'
      ),
      page.waitForLoadState("networkidle", { timeout: 120000 }).catch(() => {})
    ]);

    const bodyText = await page.locator("body").innerText();
    const normalized = bodyText.toUpperCase();

    let resultado = "ERROR_CONSULTA";
    let estado_comprobante = "OBSERVADO";
    let mensaje = "No se pudo interpretar la respuesta de SUNAT";
    const detalle = bodyText.slice(0, 2000);

    if (
      normalized.includes("ACEPTADO") ||
      normalized.includes("VALIDO") ||
      normalized.includes("VÁLIDO")
    ) {
      resultado = "VALIDADO";
      estado_comprobante = "VALIDADO";
      mensaje = "Comprobante validado en consulta web SUNAT";
    } else if (
      normalized.includes("NO EXISTE") ||
      normalized.includes("NO SE ENCONTRO") ||
      normalized.includes("NO SE ENCONTRÓ") ||
      normalized.includes("NO CORRESPONDE")
    ) {
      resultado = "NO_ENCONTRADO";
      estado_comprobante = "OBSERVADO";
      mensaje = "Comprobante no encontrado o no corresponde en consulta web SUNAT";
    }

    return res.json({
      ok: true,
      external_id,
      resultado,
      estado_comprobante,
      mensaje,
      detalle
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      external_id,
      resultado: "ERROR_CONSULTA",
      estado_comprobante: "ERROR",
      mensaje: error.message || "Error en consulta SUNAT"
    });
  } finally {
    try {
      if (page) await page.close();
    } catch {}
    try {
      if (context) await context.close();
    } catch {}
    try {
      if (browser) await browser.close();
    } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`SUNAT worker listening on ${PORT}`);
});
