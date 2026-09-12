import type { IncomingMessage, ServerResponse } from "node:http";
import exportWorkbook from "../server/vercel-export-workbook";
import generateReport from "../server/vercel-report-generator";
import verifyReport from "../server/vercel-report-verifier";

type VercelRequest = IncomingMessage & { url?: string; body?: unknown };
type VercelResponse = ServerResponse & {
  status: (code: number) => VercelResponse;
  json: (value: unknown) => void;
};

/** Same-origin Vercel proxy for the Google Apps Script Web App. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
  if (!scriptUrl) return res.status(500).json({ error: "GOOGLE_SCRIPT_URL is not configured" });
  const incoming = new URL(req.url ?? "/api", "http://vercel.internal");
  const path = incoming.searchParams.get("path") || incoming.pathname.replace(/^\/api\/?/, "");

  // Keep custom binary/report endpoints within this one deployed Function.
  // Every other endpoint is a transparent proxy to Apps Script.
  if (path === "export" || path === "export.xlsx") return exportWorkbook(req, res);
  if (path === "reports/generate") return generateReport(req, res);
  if (path === "reports/verify") return verifyReport(req, res);

  const target = new URL(scriptUrl);
  target.searchParams.set("path", path);
  for (const [key, value] of incoming.searchParams) {
    if (key !== "path") target.searchParams.append(key, value);
  }
  if (req.method && req.method !== "GET" && req.method !== "POST")
    target.searchParams.set("method", req.method);
  const body = req.method === "GET" || req.method === "HEAD"
    ? undefined
    : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
  try {
    const upstream = await fetch(target, {
      method: req.method === "GET" || req.method === "HEAD" ? req.method : "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body,
      redirect: "follow",
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
    if (req.method === "GET" && upstream.ok) {
      // Serve repeated Sheet reads from Vercel's edge cache; the browser gets
      // stale data immediately while the CDN refreshes in the background.
      res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=3600");
    }
    res.end(text);
  } catch (error) {
    res.status(502).json({ error: String(error) });
  }
}
