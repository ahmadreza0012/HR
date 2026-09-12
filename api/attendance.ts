export default async function handler(req: any, res: any) {
  const script = process.env.GOOGLE_SCRIPT_URL;
  if (!script) return res.status(500).json({ error: "GOOGLE_SCRIPT_URL is not configured" });
  const incoming = new URL(req.url || "/api/attendance", "http://vercel.internal");
  const target = new URL(script);
  target.searchParams.set("path", "attendance");
  if (incoming.searchParams.has("date")) target.searchParams.set("date", incoming.searchParams.get("date")!);
  try {
    const upstream = await fetch(target, { redirect: "follow" });
    res.status(upstream.status).setHeader("Content-Type", "application/json").end(await upstream.text());
  } catch (error) { res.status(502).json({ error: String(error) }); }
}
