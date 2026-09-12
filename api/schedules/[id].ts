export default async function handler(req: any, res: any) {
  const script = process.env.GOOGLE_SCRIPT_URL;
  if (!script) return res.status(500).json({ error: "GOOGLE_SCRIPT_URL is not configured" });
  const id = String(req.query?.id || "");
  const target = new URL(script);
  target.searchParams.set("path", `schedules/${id}`);
  target.searchParams.set("method", req.method || "GET");
  try {
    const body = req.method === "GET" ? undefined : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    const upstream = await fetch(target, { method: req.method === "GET" ? "GET" : "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body, redirect: "follow" });
    res.status(upstream.status).setHeader("Content-Type", "application/json").end(await upstream.text());
  } catch (error) { res.status(502).json({ error: String(error) }); }
}
