import type { IncomingMessage, ServerResponse } from "node:http";
type Request = IncomingMessage & { body?: unknown; url?: string };
type Response = ServerResponse & { status: (code: number) => Response; json: (value: unknown) => void };
export default async function handler(req: Request, res: Response) {
  try {
    const input = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body ?? {}) as Record<string, string>;
    const reportId = input.reportId || new URL(req.url ?? "", "https://local").searchParams.get("reportId");
    const hash = input.hash || new URL(req.url ?? "", "https://local").searchParams.get("hash");
    if (!reportId) return res.status(400).json({ error: "reportId is required" });
    const script = process.env.GOOGLE_SCRIPT_URL; if (!script) return res.status(500).json({ error: "GOOGLE_SCRIPT_URL is not configured" });
    const target = new URL(script); target.searchParams.set("path", `reports/verify/${reportId}`); if (hash) target.searchParams.set("hash", hash);
    const upstream = await fetch(target); const data = await upstream.json(); res.status(upstream.status).json(data);
  } catch (error) { res.status(500).json({ error: String(error) }); }
}
