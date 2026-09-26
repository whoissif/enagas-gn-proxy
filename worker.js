// Códigos "amigables" para los accesos rápidos de la calculadora; el proxy
// también acepta cualquier otro código real de Enagás vía ?codigo=XXXXX
// (los 1.675 municipios/zonas de https://www.enagas.es/.../gasbytown.townitem.json).
const ATAJOS = {
  madrid: "28MA2",
  barcelona: "08019",
  valencia: "46250",
  sevilla: "41091",
};

const ALLOWED_ORIGINS = new Set([
  "https://whoissif.github.io",
]);

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://whoissif.github.io";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function fmtDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parseEsNumber(str) {
  return parseFloat(String(str).replace(",", "."));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const atajo = (url.searchParams.get("municipio") || "").toLowerCase();
    const codigo = (url.searchParams.get("codigo") || ATAJOS[atajo] || "").toUpperCase();

    // Los códigos reales de Enagás son de 5 caracteres (dígitos, o dígitos+letras
    // para zonas con varios distribuidores, p. ej. "28MA2"). Esto solo descarta
    // basura evidente; la validación real la hace la propia respuesta de Enagás.
    if (!/^[0-9A-Z]{4,6}$/.test(codigo)) {
      return new Response(JSON.stringify({
        error: "código de municipio inválido o ausente",
        uso: "GET /?codigo=XXXXX  (o  ?municipio=madrid|barcelona|valencia|sevilla)",
        listaCompleta: "https://www.enagas.es/content/enagas/es/gestion-tecnica-sistema/energy-data/informacion-comercial/factor-conversion-facturacion/calidad-gas-municipio/jcr:content/responsiveGrid/container/gasbytown.townitem.json",
      }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const hoy = new Date();
    const hace35 = new Date(hoy.getTime() - 35 * 24 * 60 * 60 * 1000);
    const enagasUrl =
      "https://www.enagas.es/content/enagas/es/gestion-tecnica-sistema/energy-data/informacion-comercial/factor-conversion-facturacion/calidad-gas-municipio/jcr:content/responsiveGrid/container/gasbytown.gasbytowndto.json" +
      `?fechaIni=${fmtDate(hace35)}&fechaFin=${fmtDate(hoy)}&municipio=${encodeURIComponent(codigo)}&presion=Todas`;

    let datos;
    try {
      const resp = await fetch(enagasUrl, { headers: { Accept: "application/json" } });
      if (!resp.ok) throw new Error("Enagás respondió " + resp.status);
      datos = await resp.json();
      if (!Array.isArray(datos) || datos.length === 0) throw new Error("respuesta vacía: código probablemente inexistente");
    } catch (e) {
      return new Response(JSON.stringify({ error: "No se pudo consultar Enagás", detalle: String(e) }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    // El mes en curso puede tener días finales sin PCS diario todavía; nos quedamos
    // con el registro más reciente que sí trae PCS mensual acumulado.
    const conDatos = datos.filter((d) => d.pcsmensual);
    const ultimo = conDatos[conDatos.length - 1] || datos[datos.length - 1];

    const factores = {};
    ultimo.presion.forEach((p, i) => {
      factores[p] = parseEsNumber(ultimo.factorcorreccion[i]);
    });

    const salida = {
      codigo,
      nombre: ultimo.municipio,
      fecha: ultimo.fecha,
      pcsMensual: parseEsNumber(ultimo.pcsmensual),
      factores,
      fuente: "https://www.enagas.es/es/gestion-tecnica-sistema/energy-data/informacion-comercial/factor-conversion-facturacion/calidad-gas-municipio/",
    };

    const response = new Response(JSON.stringify(salida), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        ...corsHeaders(origin),
      },
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
