import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const DESTINATION = "pettersson81@suomi24.fi";
const BREVO_SENDER_ID = Number(Deno.env.get("BREVO_SENDER_ID") || "3");
const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY");
const allowedHeaders = "content-type, apikey, x-client-info";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": allowedHeaders,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const recentRequests = new Map<string, { count: number; resetAt: number }>();

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function clean(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]!);
}

function row(label: string, value: string): string {
  if (!value) return "";
  return `<tr><th align="left" style="padding:9px 12px;border-bottom:1px solid #dbe5ef;color:#4b6078;width:190px">${escapeHtml(label)}</th><td style="padding:9px 12px;border-bottom:1px solid #dbe5ef;white-space:pre-wrap">${escapeHtml(value)}</td></tr>`;
}

function rateLimited(request: Request): boolean {
  const ip = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-real-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
  const now = Date.now();
  const current = recentRequests.get(ip);
  if (!current || current.resetAt <= now) {
    recentRequests.set(ip, { count: 1, resetAt: now + 15 * 60_000 });
    return false;
  }
  current.count += 1;
  return current.count > 3;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return reply(405, { error: "Käytä POST-pyyntöä." });
  if (Number(request.headers.get("content-length") || 0) > 20_000) return reply(413, { error: "Lähetys on liian suuri." });
  if (!BREVO_API_KEY) return reply(503, { error: "Sähköpostipalvelu ei ole juuri nyt käytettävissä. Yritä myöhemmin uudelleen." });
  if (rateLimited(request)) return reply(429, { error: "Lähetit useita ilmoituksia lyhyessä ajassa. Yritä myöhemmin uudelleen." });

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return reply(400, { error: "Lähetyksen tiedot eivät olleet luettavassa muodossa." });
  }

  if (clean(input.website, 200)) return reply(200, { ok: true, reference: "" });
  if (Number(input.elapsed_ms) < 900) return reply(400, { error: "Tarkista lomake ja yritä uudelleen." });

  const data = {
    name: clean(input.full_name, 120),
    email: clean(input.email, 254).toLowerCase(),
    phone: clean(input.phone, 40),
    dealer: clean(input.dealer_name, 160),
    car: clean(input.car, 160),
    registration: clean(input.registration, 24),
    purchaseDate: clean(input.purchase_date, 10),
    mileage: clean(input.mileage, 12),
    noticed: clean(input.noticed, 120),
    repairEstimate: clean(input.repair_estimate, 32),
    description: clean(input.description, 5000),
    desiredOutcome: clean(input.desired_outcome, 2500),
  };

  if (!data.name || !data.dealer || !data.car || !data.description || !data.desiredOutcome) {
    return reply(400, { error: "Täydennä kaikki pakolliset kentät." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    return reply(400, { error: "Tarkista sähköpostiosoitteen muoto." });
  }
  if (data.mileage && (!/^\d{1,7}$/.test(data.mileage) || Number(data.mileage) > 1_000_000)) {
    return reply(400, { error: "Tarkista kilometrimäärä." });
  }
  if (data.repairEstimate && (!/^\d{1,8}(?:[.,]\d{1,2})?$/.test(data.repairEstimate) || Number(data.repairEstimate.replace(",", ".")) > 10_000_000)) {
    return reply(400, { error: "Tarkista korjausarvio." });
  }
  if (data.purchaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(data.purchaseDate)) {
    return reply(400, { error: "Tarkista ostopäivä." });
  }

  const reference = `AC-${new Date().getUTCFullYear()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  const htmlContent = `<!doctype html><html lang="fi"><body style="font:15px/1.6 Arial,sans-serif;color:#14283f"><h2 style="color:#155da8">Uusi kuluttajan ilmoitus Autoclaimille</h2><p><strong>Viite:</strong> ${reference}</p><table style="border-collapse:collapse;width:100%;max-width:760px">${row("Nimi", data.name)}${row("Sähköposti", data.email)}${row("Puhelin", data.phone)}${row("Autoliike", data.dealer)}${row("Auto", data.car)}${row("Rekisterinumero", data.registration)}${row("Ostopäivä", data.purchaseDate)}${row("Kilometrit", data.mileage)}${row("Vian havaitsemisaika", data.noticed)}${row("Korjausarvio (€)", data.repairEstimate)}${row("Vian kuvaus", data.description)}${row("Toivottu seuraava askel", data.desiredOutcome)}</table><p style="margin-top:22px;color:#60738b;font-size:12px">Ilmoitus lähetettiin Autoclaimin kuluttajalomakkeella. Viite ${reference}.</p></body></html>`;

  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json", "api-key": BREVO_API_KEY },
      body: JSON.stringify({
        sender: { id: BREVO_SENDER_ID },
        to: [{ email: DESTINATION }],
        replyTo: { email: data.email, name: data.name },
        subject: `Autoclaim – uusi kuluttajan ilmoitus ${reference}`,
        htmlContent,
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      console.error("Brevo rejected consumer email", response.status, detail.slice(0, 250));
      return reply(502, { error: "Sähköpostin lähetys epäonnistui. Tietojasi ei lähetetty. Yritä hetken kuluttua uudelleen." });
    }
    return reply(200, { ok: true, reference });
  } catch (error) {
    console.error("Consumer email delivery failed", error instanceof Error ? error.message : "unknown error");
    return reply(502, { error: "Sähköpostin lähetys epäonnistui. Tietojasi ei lähetetty. Yritä hetken kuluttua uudelleen." });
  }
});

