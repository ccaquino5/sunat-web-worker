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
  console.log("=== NUEVA CONSULTA SUNAT ===");
  console.log("BODY:", JSON.stringify(req.body, null, 2));

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

    await page.waitForTimeout(5000);

    const fillFirst = async (selectors, value) => {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        try {
          if (await locator.count()) {
            await locator.fill(String(value));
            return selector;
          }
        } catch {}
      }
      return null;
    };

    const selectFirst = async (selectors, value) => {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        try {
          if (await locator.count()) {
            await locator.selectOption(String(value));
            return selector;
          }
        } catch {}
      }
      return null;
    };

    const visibleInputsMeta = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll("input, select, textarea"));
      return els.map((el, idx) => ({
        idx,
        tag: el.tagName,
        type: el.getAttribute("type"),
        name: el.getAttribute("name"),
        id: el.getAttribute("id"),
        placeholder: el.getAttribute("placeholder"),
        value: el.value,
        outer: el.outerHTML.slice(0, 300)
      }));
    });

    console.log("=== INPUTS/SELECTS DETECTADOS ===");
    console.log(JSON.stringify(visibleInputsMeta, null, 2));

    const textInputs = page.locator(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="radio"]):not([type="checkbox"])'
    );

    const fillByIndex = async (index, value) => {
      const count = await textInputs.count();
      if (count > index) {
        const locator = textInputs.nth(index);
        await locator.fill(String(value));
        return `textInputIndex:${index}`;
      }
      return null;
    };

    const selects = page.locator("select");

    const selectByIndex = async (index, value) => {
      const count = await selects.count();
      if (count > index) {
        const locator = selects.nth(index);
        await locator.selectOption(String(value));
        return `selectIndex:${index}`;
      }
      return null;
    };

    let used;

    // RUC
    used = await fillFirst(
      [
        'input[name*="numRuc"]',
        'input[id*="ruc"]',
        'input[name*="ruc"]'
      ],
      ruc_proveedor
    );
    if (!used) used = await fillByIndex(0, ruc_proveedor);
    if (!used) throw new Error(`No se encontró campo RUC`);

    // Tipo comprobante
    used = await selectFirst(
      [
        'select[name*="codComp"]',
        'select[id*="codComp"]',
        'select[name*="tipo"]'
      ],
      sunat_tipo_comprobante_web
    );
    if (!used) used = await selectByIndex(0, sunat_tipo_comprobante_web);
    if (!used) throw new Error(`No se encontró combo tipo comprobante`);

    // Serie
    used = await fillFirst(
      [
        'input[name*="numSerie"]',
        'input[id*="serie"]',
        'input[name*="serie"]'
      ],
      String(sunat_serie_web).trim()
    );
    if (!used) used = await fillByIndex(1, String(sunat_serie_web).trim());
    if (!used) throw new Error(`No se encontró campo serie`);

    // Número comprobante
    used = await fillFirst(
      [
        'input[name*="numCpe"]',
        'input[id*="numCpe"]',
        'input[id*="comprobante"]',
        'input[name*="comprobante"]',
        'input[id*="numero"]',
        'input[name*="numero"]'
      ],
      String(sunat_numero_web).trim()
    );
    if (!used) used = await fillByIndex(2, String(sunat_numero_web).trim());
    if (!used) used = await fillByIndex(3, String(sunat_numero_web).trim());
    if (!used) throw new Error(`No se encontró campo para valor: ${sunat_numero_web}`);

    // Fecha
    used = await fillFirst(
      [
        'input[name*="fecEmision"]',
        'input[id*="fecEmision"]',
        'input[id*="fecha"]',
        'input[name*="fecha"]'
      ],
      fecha
    );
    if (!used) used = await fillByIndex(3, fecha);
    if (!used) used = await fillByIndex(4, fecha);
    if (!used) throw new Error(`No se encontró campo fecha`);

    // Importe
    used = await fillFirst(
      [
        'input[name*="mtoImporte"]',
        'input[id*="mtoImporte"]',
        'input[id*="importe"]',
        'input[name*="importe"]'
      ],
      importe
    );
    if (!used) used = await fillByIndex(4, importe);
    if (!used) used = await fillByIndex(5, importe);
    if (!used) throw new Error(`No se encontró campo importe`);

    const snapshot = await page.locator("body").innerText();
    console.log("=== SUNAT PAGE SNAPSHOT ===");
    console.log(snapshot.slice(0, 4000));

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

    console.log("=== RESULTADO SUNAT ===");
    console.log(
      JSON.stringify(
        {
          external_id,
          resultado,
          estado_comprobante,
          mensaje
        },
        null,
        2
      )
    );

    return res.json({
      ok: true,
      external_id,
      resultado,
      estado_comprobante,
      mensaje,
      detalle
    });
  } catch (error) {
    console.error("=== ERROR SUNAT ===");
    console.error(error);

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
