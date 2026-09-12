import type { IncomingMessage, ServerResponse } from "node:http";

type Request = IncomingMessage & { body?: unknown };
type Response = ServerResponse & { status: (code: number) => Response; json: (value: unknown) => void };

/** Explicit Vercel route: avoids relying on catch-all routing for the demo seed. */
export default async function handler(req: Request, res: Response) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST. Open the Reports page and choose Create demo data, or send a POST request to this URL." });
  const script = process.env.GOOGLE_SCRIPT_URL;
  if (!script) return res.status(500).json({ error: "GOOGLE_SCRIPT_URL is not configured in Vercel" });
  try {
    const target = new URL(script); target.searchParams.set("path", "admin/seed-demo");
    const upstream = await fetch(target, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: "{}" });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (error) { res.status(502).json({ error: String(error) }); }
}
