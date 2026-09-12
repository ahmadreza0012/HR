"use client";

import { FormEvent, useState } from "react";
import "../globals.css";

const API = (import.meta.env.VITE_API_URL ?? (import.meta.env.PROD ? "/api" : "http://localhost:3001/api")).replace(/\/$/, "");

export default function VerifyReportPage() {
  const [reportId, setReportId] = useState("");
  const [hash, setHash] = useState("");
  const [result, setResult] = useState<any>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const response = await fetch(`${API}/reports/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reportId, hash }) });
    setResult(await response.json());
  };
  return <main className="app-shell verify-page" dir="ltr"><section className="workspace"><div className="page-head"><div><span className="eyebrow">DASTRANJ REPORT INTEGRITY</span><h1>Verify a report</h1><p>Compare the SHA-256 hash in a downloaded report with the append-only registry.</p></div></div><section className="panel"><form className="upload-box" onSubmit={submit}><label>Report ID<input value={reportId} onChange={(e) => setReportId(e.target.value)} required /></label><label>SHA-256 hash<input value={hash} onChange={(e) => setHash(e.target.value)} placeholder="64-character hash" /></label><button className="primary-button">Verify</button></form>{result && <div className={`import-result ${result.status === "Valid" ? "success" : "error"}`}><h2>{result.status}</h2><p>{result.message ?? (result.status === "Valid" ? "The submitted hash matches the issued report." : "The report cannot be validated as issued.")}</p>{result.report && <p>Employee: {result.report.employeeName} · Issued: {result.report.issuedAt} · Timezone: {result.report.timezone}</p>}</div>}</section></section></main>;
}
