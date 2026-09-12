export default async function handler(req: any, res: any) {
  const script = process.env.GOOGLE_SCRIPT_URL;
  if (!script) return res.status(500).json({ error: "GOOGLE_SCRIPT_URL is not configured" });
  const target = new URL(script);
  target.searchParams.set("path", "payroll/periods");
  try {
    const upstream = await fetch(target, { redirect: "follow" });
    res.status(upstream.status).setHeader("Content-Type", "application/json");
    if (upstream.ok) res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    res.end(await upstream.text());
  } catch (error) { res.status(502).json({ error: String(error) }); }
}
