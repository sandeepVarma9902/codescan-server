/**
 * CodeScan Proxy Server
 * - Forwards AI requests to Groq/Anthropic
 * - Fetches CMS measure specs (bypasses CORS)
 * - Caches CMS data to avoid repeated fetches
 */

import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// In-memory cache (24hr TTL)
const cmsCache = {};
const CACHE_TTL = 86400000;

// ── AI Proxy ──────────────────────────────────────────────────────────────────
app.post("/api/review", async (req, res) => {
  const groqKey      = process.env.GROQ_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (groqKey) {
    try {
      const { messages, max_tokens } = req.body;
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${groqKey}` },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, max_tokens: max_tokens || 4000, temperature: 0.1 }),
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      res.json({ content: [{ type: "text", text: data.choices?.[0]?.message?.content || "" }] });
    } catch (err) { res.status(500).json({ error: err.message }); }

  } else if (anthropicKey) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json(data);
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  } else {
    res.status(400).json({ error: "No API key set." });
  }
});

// ── CMS QPP Measures List ─────────────────────────────────────────────────────
app.get("/api/cms/measures/:year", async (req, res) => {
  const { year } = req.params;
  const key = `measures_${year}`;

  if (cmsCache[key] && Date.now() - cmsCache[key].ts < CACHE_TTL) {
    return res.json({ ...cmsCache[key].data, cached: true });
  }

  try {
    const r = await fetch(`https://qpp.cms.gov/api/measures?year=${year}&category=quality`, {
      headers: { "Accept": "application/json", "User-Agent": "EHR-MIPS-Tool/1.0" }
    });
    if (!r.ok) throw new Error(`CMS QPP API returned ${r.status}`);
    const data = await r.json();
    cmsCache[key] = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── CMS Specific Measure Detail ───────────────────────────────────────────────
app.get("/api/cms/measure/:year/:id", async (req, res) => {
  const { year, id } = req.params;
  const key = `measure_${year}_${id}`;

  if (cmsCache[key] && Date.now() - cmsCache[key].ts < CACHE_TTL) {
    return res.json({ ...cmsCache[key].data, cached: true });
  }

  try {
    // Fetch all quality measures for the year
    const r = await fetch(`https://qpp.cms.gov/api/measures?year=${year}&category=quality`, {
      headers: { "Accept": "application/json", "User-Agent": "EHR-MIPS-Tool/1.0" }
    });

    if (!r.ok) throw new Error(`CMS API ${r.status}`);
    const allData = await r.json();
    const measures = allData?.data || allData?.measures || allData || [];

    // Find the specific measure
    const measure = Array.isArray(measures) ? measures.find(m =>
      String(m.measureId || m.qualityId || m.number || m.id) === String(id)
    ) : null;

    const result = { id, year, measure, totalMeasures: Array.isArray(measures) ? measures.length : 0, fetchedAt: new Date().toISOString() };
    cmsCache[key] = { data: result, ts: Date.now() };
    res.json(result);

  } catch (err) {
    res.status(502).json({ error: err.message, id, year });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({
  status: "ok",
  engine: process.env.GROQ_API_KEY ? "Groq" : process.env.ANTHROPIC_API_KEY ? "Anthropic" : "No key",
  cmsCache: Object.keys(cmsCache).length + " entries",
}));

app.listen(PORT, () => {
  console.log(`\n⚡ CodeScan proxy → http://localhost:${PORT}`);
  console.log(`   Groq: ${process.env.GROQ_API_KEY ? "✅" : "❌"}  Anthropic: ${process.env.ANTHROPIC_API_KEY ? "✅" : "❌"}`);
});